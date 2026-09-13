import { Injectable, OnModuleInit } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { EntryDoc, EntryI, OutboxEventI, PostingDoc, signedDelta } from "./types";
import { WalletBalance } from "../wallets/dto";
import { IdempotencyRepository } from "./idempotency.repository";
import { AppError, OccConflict } from "../common/errors";
import { ClientSession, Filter, MongoServerError } from "mongodb";
import { randomUUID } from "crypto";
import { AccountsRepository } from "../accounts/accounts.repository";
import { AccountDoc, AccountRef, systemAccountId, userAccountId } from "../accounts/account";
import { fromDecimal128, toDecimal128 } from "../common/money";
import { OutboxRepository } from "./outbox.repository";

const OCC_MAX_RETRIES = 8;

export interface PrePostContext {
  readBalance(ownerId: string, currency: string): Promise<WalletBalance>;
  referenceNetAmount(reference: string, account: AccountRef, operationTypes?: string[]): Promise<bigint>;
  session: ClientSession
}

export interface PostPostingContext {
  accountBalance(ownerId: string, currency: string): Promise<WalletBalance>;
  operationId: string;
  entryIds: string[]
}

export interface LedgerOperation<T> {
  entries: EntryI[];
  guardNegative?: AccountRef[];
  reversalOf?: string;
  sideEffect?: (post: PostPostingContext) => Promise<void>;
  buildResponse: (post: PostPostingContext) => T | Promise<T>;
  buildEvent: (post: PostPostingContext) => OutboxEventI | OutboxEventI [] | Promise<OutboxEventI | OutboxEventI[]>;
}

export interface PostArgs<T> {
  tenantId: string;
  idempotencyKey: string;
  operationType: string;
  requestPayload: unknown;
  reference?: string | null;
  actor?: string | null;
  generateLedgerOps: (ctx: PrePostContext) => Promise<LedgerOperation<T>>;
}

@Injectable()
export class LedgerService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly idempotency: IdempotencyRepository,
    private readonly accountsRepo: AccountsRepository,
    private readonly outboxRepo: OutboxRepository
  ) {}

  async onModuleInit(): Promise<void> {
    await this.db.db.createCollection('postings').catch(() => undefined);
    await this.db.db.createCollection('entries').catch(() => undefined);
    const postings = this.db.collection<PostingDoc>('postings');
    await postings.createIndex({ accountId: 1, sequence: 1 });
    await postings.createIndex({ operationId: 1 });
    await postings.createIndex({ tenantId: 1, reference: 1 });
    const entries = this.db.collection<EntryDoc>('entries');
    await entries.createIndex({ operationId: 1 });
    await entries.createIndex({ tenantId: 1, reference: 1 })
  }

  async post<T>(args: PostArgs<T>): Promise<T> {
    const { tenantId, idempotencyKey, operationType } = args;
    const requestHash = IdempotencyRepository.hash(operationType, args.requestPayload);
    const existing = await this.idempotency.find(tenantId, idempotencyKey);
    if (existing) return this.replay<T>(existing, requestHash, idempotencyKey);

    for (let attempt = 0; attempt < OCC_MAX_RETRIES; attempt++) {
      const session = this.db.startSession();
      try {
        let response!: T;
        await session.withTransaction(
          async () => {
            response = await this.execute(args, requestHash, session);
          },
          { readConcern: { level: 'snapshot'}, writeConcern: { w: 'majority' }}
        )
        return response;
      } catch (err) {
        await session.abortTransaction().catch(() => undefined);
        if (err instanceof OccConflict || isTransient(err)) {
          continue; 
        }
        if (isDuplicateKey(err)) {
          // Concurrent first-writter won the idempotency race, return its result
          const existingRecord = await this.idempotency.find(tenantId, idempotencyKey);
          if (existingRecord) return this.replay<T>(existingRecord, requestHash, idempotencyKey);
          continue;
        }
        throw err;
      } finally {
        await session.endSession();
      }
    }
    throw AppError.retryExhausted
  }

  private replay<T>(
    existing: { requestHash: string; result: unknown },
    requestHash: string,
    key: string,
  ): T {
    if (existing.requestHash !== requestHash) throw AppError.IdempotencyKeyReuse(key);
    return existing.result as T;
  }

  private async execute<T> (
    args: PostArgs<T>,
    requestHash: string,
    session: ClientSession
  ): Promise<T> {
    const { tenantId } = args;
    const operationId = randomUUID();

    const PrePostContext: PrePostContext = {
      session,
      readBalance: async(ownerId, currency) => {
        await this.accountsRepo.ensureUserWallet(tenantId, ownerId, currency, session);
        const accountBalance = await this.accountsRepo.balanceBreakdown(tenantId, ownerId, currency, session);
        return accountBalance!
      },
      referenceNetAmount: async (reference, account, operationTypes) => {
        const accountId = this.resolveId(tenantId, account);
        const filter: Filter<PostingDoc> = { tenantId, reference, accountId };
        if (operationTypes) filter.operationType = { $in: operationTypes };
        const postings = await this.db
          .collection<PostingDoc>('postings')
          .find(filter, { session })
          .toArray();
        return postings.reduce((sum, p) => sum + signedDelta(p.direction, fromDecimal128(p.amount)), 0n);
      }
    }

    const legderOperation = await args.generateLedgerOps(PrePostContext)
    this.validatePostingBalanced(legderOperation.entries);

    // Provision and load every related accounts
    const accountRefs = legderOperation.entries.flatMap((entry) => entry.postings.map((posting) => posting.account));
    await this.ensureAccounts(tenantId, accountRefs, session);
    const accountsById = await this.loadAccounts(tenantId, accountRefs, session);

    // Compute per-account new balance
    const postingDocs: PostingDoc[] = [];
    const entryDocs: EntryDoc[] = [];
    const finalBalances = new Map<string, { balance: bigint; sequence: number; version: number}>();

    for (const entry of legderOperation.entries) {
      const entryId = randomUUID();
      const postingIds: string[] = [];
      for (const posting of entry.postings) {
        const accountId = this.resolveId(tenantId, posting.account);
        const doc = accountsById.get(accountId)!;
        const state = finalBalances.get(accountId) ?? {
          balance: fromDecimal128(doc.balance),
          sequence: doc.sequence,
          version: doc.version,
        };

        state.balance += signedDelta(posting.direction, posting.amount);
        const isUser = doc.kind === 'user';
        if (isUser) state.sequence += 1;
        finalBalances.set(accountId, state);

        const postingId = randomUUID();
        postingIds.push(postingId);
        postingDocs.push({
          _id: postingId,
          tenantId,
          operationId,
          entryId,
          accountId,
          ownerId: doc.ownerId,
          currency: entry.currency,
          direction: posting.direction,
          amount: toDecimal128(posting.amount),
          balanceAfter: isUser ? toDecimal128(state.balance) : null,
          sequence: isUser ? state.sequence : null,
          operationType: args.operationType,
          reference: args.reference ?? null,
          actor: args.actor ?? null,
          createdAt: new Date(),
        })
      }

      entryDocs.push({
        _id: entryId,
        tenantId,
        operationId,
        currency: entry.currency,
        operationType: args.operationType,
        postingIds,
        reference: args.reference ?? null,
        actor: args.actor ?? null,
        reversalOf: legderOperation.reversalOf ?? null,
        createdAt: new Date(),
      })
    }

    // Overdraft guard: some accounts must not end negative
    for (const ref of legderOperation.guardNegative ?? []) {
      const id = this.resolveId(tenantId, ref);
      const state = finalBalances.get(id);
      if (state && state.balance < 0n) {
        const doc = accountsById.get(id)!;
        throw AppError.insufficientFunds({
          accountType: doc.accountType,
          currency: doc.currency,
          available: fromDecimal128(doc.balance).toString(),
          availableAfter: state.balance.toString(),
        });
      }
    }

    // Apply account updates: user accounts OCC-guarded, system read-modify-write
    for (const [accountId, state] of finalBalances) {
      const doc = accountsById.get(accountId)!;
      if (doc.kind === 'user') {
        const res = await this.db.collection<AccountDoc>('accounts').updateOne(
          { _id: accountId, version: doc.version },
          {
            $set: {
              balance: toDecimal128(state.balance),
              sequence: state.sequence,
              updatedAt: new Date()
            },
            $inc: { version: 1 }
          },
          { session },
        );
        if (res.matchedCount === 0) throw new OccConflict();
      } else {
        await this.db.collection<AccountDoc>('accounts').updateOne(
          { _id: accountId },
          { $set: { balance: toDecimal128(state.balance), updatedAt: new Date() } },
          { session }
        )
      }
    }

    await this.db.collection<PostingDoc>('postings').insertMany(postingDocs, { session });
    await this.db.collection<EntryDoc>('entries').insertMany(entryDocs, { session });

    const post: PostPostingContext = {
      operationId,
      entryIds: entryDocs.map((e) => e._id),
      accountBalance: async (ownerId, currency) => {
        const b = await this.accountsRepo.balanceBreakdown(tenantId, ownerId, currency, session);
        return b!;
      }
    }

    if (legderOperation.sideEffect) await legderOperation.sideEffect(post);
    const response = await legderOperation.buildResponse(post);
    const events = await legderOperation.buildEvent(post);
    for (const event of Array.isArray(events) ? events : [events]){
      await this.outboxRepo.write(tenantId, operationId, event, session);
    }
    await this.idempotency.insert(
      {
        _id: IdempotencyRepository.id(tenantId, args.idempotencyKey),
        tenantId,
        key: args.idempotencyKey,
        requestHash,
        operationType: args.operationType,
        status: 'completed',
        result: response,
        createdAt: new Date()
      }, 
      session
    )

    return response;
  }

  private validatePostingBalanced(entries: EntryI[]): void {
    for (const entry of entries) {
      let net = 0n;
      for (const posting of entry.postings) net += signedDelta(posting.direction, posting.amount);
      if (net !== 0n) {
        throw AppError.validation('Entry is not balanced (debits must equal credits)', {
          currency: entry.currency,
          net: net.toString(),
        });
      }
      if (entry.postings.some((posting) => posting.amount <= 0n)) {
        throw AppError.validation('Posting amounts must be positive')
      }
    }
  }

  private resolveId(tenantId: string, ref: AccountRef): string {
    return ref.kind === 'user'
      ? userAccountId(tenantId, ref.ownerId, ref.currency, ref.accountType)
      : systemAccountId(tenantId, ref.name, ref.currency);
  }

  private async ensureAccounts(
    tenantId: string,
    accountRefs: AccountRef[],
    session: ClientSession
  ): Promise<void> {
    const userAccounts = new Set<string>();
    const systemAccounts: AccountRef[] = [];
    for (const accountRef of accountRefs) {
      if (accountRef.kind === 'user') userAccounts.add(`${accountRef.ownerId}\0${accountRef.currency}`);
      else systemAccounts.push(accountRef);
    }
    for (const key of userAccounts) {
      const [ownerId, currency] = key.split('\0');
      await this.accountsRepo.ensureUserWallet(tenantId, ownerId, currency, session)
    }
    for (const sys of systemAccounts) {
      if (sys.kind === 'system') {
        await this.accountsRepo.ensureSystem(tenantId, sys.name, sys.currency, session);
      }
    }
  }

  private async loadAccounts(
    tenantId: string,
    refs: AccountRef[],
    session: ClientSession,
  ): Promise<Map<string, AccountDoc>> {
    const ids = [...new Set(refs.map((r) => this.resolveId(tenantId, r)))];
    const docs = await this.db
      .collection<AccountDoc>('accounts')
      .find({ _id: { $in: ids }}, { session })
      .toArray();
    return new Map(docs.map((d) => [d._id, d]))
  }
}

function isTransient(err: unknown): boolean {
  return (
    err instanceof MongoServerError &&
    (err.hasErrorLabel?.('TransientTransactionError') ||
      err.hasErrorLabel?.('UnknownTransactionCommitResult') ||
      err.codeName === 'WriteConflict'
    )
  );
}

function isDuplicateKey(err: unknown): boolean {
  return err instanceof MongoServerError && err.code === 11000;
}