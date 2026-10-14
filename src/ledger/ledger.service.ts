import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { ClientSession, Model, QueryFilter, Types, mongo } from "mongoose";
import { EntryDoc, EntryI, OutboxEventI, PostingDoc, signedDelta } from "./types";
import { WalletBalance } from "../wallets/dto";
import { IdempotencyRepository } from "./idempotency.repository";
import { AppError, OccConflict } from "../common/errors";
import { AccountsRepository } from "../accounts/accounts.repository";
import { AccountDoc, AccountRef, refKey, refOf, WalletType } from "../accounts/account";
import { Account } from "../accounts/account.schema";
import { Posting } from "./schemas/posting.schema";
import { Entry } from "./schemas/entry.schema";
import { fromDecimal128, toDecimal128 } from "../common/money";
import { OutboxRepository } from "./outbox.repository";
import { LegacyWalletsService } from "./legacy-wallets.service";
import { LegacyRouteService } from "./legacy-route.service";

const OCC_MAX_RETRIES = 8;

export interface PrePostContext {
  readBalance(ownerId: string, currency: string, walletType: WalletType): Promise<WalletBalance>;
  referenceNetAmount(reference: string, account: AccountRef, operationTypes?: string[]): Promise<bigint>;
  /** Ids of entries already posted under this reference for one operationType, oldest first.
   * Lets a reversing operation point LedgerOperation.reversalOf at the entry it undoes. */
  referenceEntryIds(reference: string, operationType: string): Promise<string[]>;
  session: ClientSession
}

export interface PostPostingContext {
  accountBalance(ownerId: string, currency: string, walletType: WalletType): Promise<WalletBalance>;
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
  private readonly logger = new Logger('Ledger');

  constructor(
    @InjectModel(Posting.name) private readonly postings: Model<PostingDoc>,
    @InjectModel(Entry.name) private readonly entries: Model<EntryDoc>,
    @InjectModel(Account.name) private readonly accounts: Model<AccountDoc>,
    private readonly idempotency: IdempotencyRepository,
    private readonly accountsRepo: AccountsRepository,
    private readonly outboxRepo: OutboxRepository,
    private readonly legacyWallets: LegacyWalletsService,
    private readonly legacyRoute: LegacyRouteService
  ) {}

  async onModuleInit(): Promise<void> {
    await this.postings.createCollection().catch(() => undefined);
    await this.entries.createCollection().catch(() => undefined);
    await this.postings.syncIndexes();
    await this.entries.syncIndexes();
  }

  async post<T>(args: PostArgs<T>): Promise<T> {
    const startedAt = Date.now();
    const tag = logTag(args);
    try {
      const response = await this.postOnce(args, tag);
      this.logger.log(`${tag} completed in ${Date.now() - startedAt}ms ${describeResult(response)}`);
      return response;
    } catch (err) {
      if (err instanceof AppError) {
        this.logger.warn(
          `${tag} rejected in ${Date.now() - startedAt}ms code=${err.code} message="${err.message}"` +
            (err.details ? ` details=${safeJson(err.details)}` : ''),
        );
      } else {
        this.logger.error(
          `${tag} failed in ${Date.now() - startedAt}ms`,
          err instanceof Error ? err.stack : String(err),
        );
      }
      throw err;
    }
  }

  private async postOnce<T>(args: PostArgs<T>, tag: string): Promise<T> {
    const { tenantId, idempotencyKey, operationType } = args;
    this.logger.log(`${tag} started payload=${safeJson(args.requestPayload)}`);
    const requestHash = IdempotencyRepository.hash(operationType, args.requestPayload);
    const existing = await this.idempotency.find(tenantId, idempotencyKey);
    if (existing) return this.replay<T>(existing, requestHash, idempotencyKey, tag);

    for (let attempt = 0; attempt < OCC_MAX_RETRIES; attempt++) {
      const session = await this.accounts.db.startSession();
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
          this.logger.warn(
            `${tag} ${err instanceof OccConflict ? 'OCC conflict' : 'transient transaction error'}, ` +
              `retrying (attempt ${attempt + 1}/${OCC_MAX_RETRIES})`,
          );
          continue;
        }
        if (isDuplicateKey(err)) {
          // Concurrent first-writter won the idempotency race, return its result
          const existingRecord = await this.idempotency.find(tenantId, idempotencyKey);
          if (existingRecord) return this.replay<T>(existingRecord, requestHash, idempotencyKey, tag);
          continue;
        }
        throw err;
      } finally {
        await session.endSession();
      }
    }
    throw AppError.retryExhausted()
  }

  private replay<T>(
    existing: { requestHash: string; result: unknown },
    requestHash: string,
    key: string,
    tag: string,
  ): T {
    if (existing.requestHash !== requestHash) throw AppError.IdempotencyKeyReuse(key);
    this.logger.log(`${tag} idempotent replay, returning stored result`);
    return existing.result as T;
  }

  private async execute<T> (
    args: PostArgs<T>,
    requestHash: string,
    session: ClientSession
  ): Promise<T> {
    const { tenantId } = args;
    const operationId = new Types.ObjectId();

    const PrePostContext: PrePostContext = {
      session,
      readBalance: async(ownerId, currency, walletType) => {
        await this.accountsRepo.ensureUserWallet(tenantId, ownerId, currency, walletType, session);
        const accountBalance = await this.accountsRepo.balanceBreakdown(
          tenantId, ownerId, currency, walletType, session
        );
        return accountBalance!
      },
      referenceNetAmount: async (reference, account, operationTypes) => {
        // Filters on the denormalized ref fields rather than accountId. That is what lets
        // this run during generateLedgerOps, i.e. before ensureAccounts/loadAccounts have
        // provisioned anything and before any account _id exists to resolve.
        const filter: QueryFilter<PostingDoc> =
          account.kind === 'user'
            ? {
                tenantId,
                reference,
                kind: 'user',
                ownerId: account.ownerId,
                currency: account.currency,
                walletType: account.walletType,
                accountType: account.accountType
              }
            : {
                tenantId,
                reference,
                kind: 'system',
                accountType: account.name,
                currency: account.currency
              };
        if (operationTypes) filter.operationType = { $in: operationTypes };
        const postings = await this.postings
          .find(filter, null, { session })
          .lean<PostingDoc[]>()
          .exec();
        return postings.reduce((sum, p) => sum + signedDelta(p.direction, fromDecimal128(p.amount)), 0n);
      },
      referenceEntryIds: async (reference, operationType) => {
        const entries = await this.entries
          .find({ tenantId, reference, operationType }, null, { session })
          .sort({ createdAt: 1 })
          .lean<EntryDoc[]>()
          .exec();
        return entries.map((e) => e._id.toHexString());
      }
    }

    // A transaction from before the owner's cutover is applied the way legacy would have.
    const legderOperation = (await this.legacyRoute.plan(args, PrePostContext)) ?? await args.generateLedgerOps(PrePostContext)
    this.validatePostingBalanced(legderOperation.entries);

    // Provision and load every related accounts
    const accountRefs = legderOperation.entries.flatMap((entry) => entry.postings.map((posting) => posting.account));
    await this.ensureAccounts(tenantId, accountRefs, session);
    const accountsByRef = await this.loadAccounts(tenantId, accountRefs, session);

    // Compute per-account new balance
    const postingDocs: PostingDoc[] = [];
    const entryDocs: EntryDoc[] = [];
    const finalBalances = new Map<string, { balance: bigint; sequence: number; version: number}>();

    for (const entry of legderOperation.entries) {
      const entryId = new Types.ObjectId();
      const postingIds: Types.ObjectId[] = [];
      const reference = entry.reference ?? args.reference ?? null;
      const operationType = entry.operationType ?? args.operationType;
      for (const posting of entry.postings) {
        const key = refKey(posting.account);
        const doc = accountsByRef.get(key);
        if (!doc) throw new Error(`Account was not provisioned for posting: ${key}`);
        const state = finalBalances.get(key) ?? {
          balance: fromDecimal128(doc.balance),
          sequence: doc.sequence,
          version: doc.version,
        };

        state.balance += signedDelta(posting.direction, posting.amount);
        const isUser = doc.kind === 'user';
        if (isUser) state.sequence += 1;
        finalBalances.set(key, state);

        const postingId = new Types.ObjectId();
        postingIds.push(postingId);
        postingDocs.push({
          _id: postingId,
          tenantId,
          operationId,
          entryId,
          accountId: doc._id,
          ownerId: doc.ownerId,
          walletType: doc.walletType,
          accountType: doc.accountType,
          kind: doc.kind,
          currency: entry.currency,
          direction: posting.direction,
          amount: toDecimal128(posting.amount),
          balanceAfter: isUser ? toDecimal128(state.balance) : null,
          sequence: isUser ? state.sequence : null,
          operationType,
          reference,
          actor: args.actor ?? null,
          createdAt: new Date(),
        })
      }

      entryDocs.push({
        _id: entryId,
        tenantId,
        operationId,
        currency: entry.currency,
        operationType,
        postingIds,
        reference,
        actor: args.actor ?? null,
        reversalOf: legderOperation.reversalOf
          ? new Types.ObjectId(legderOperation.reversalOf)
          : null,
        metadata: entry.metadata ?? null,
        createdAt: new Date(),
      })
    }

    // Overdraft guard: some accounts must not end negative
    for (const ref of legderOperation.guardNegative ?? []) {
      const key = refKey(ref);
      const state = finalBalances.get(key);
      if (state && state.balance < 0n) {
        const doc = accountsByRef.get(key)!;
        throw AppError.insufficientFunds({
          accountType: doc.accountType,
          currency: doc.currency,
          available: fromDecimal128(doc.balance).toString(),
          availableAfter: state.balance.toString(),
        });
      }
    }

    // Apply account updates: user accounts OCC-guarded, system read-modify-write
    for (const [key, state] of finalBalances) {
      const doc = accountsByRef.get(key)!;
      if (doc.kind === 'user') {
        const res = await this.accounts.updateOne(
          { _id: doc._id, version: doc.version },
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
        await this.accounts.updateOne(
          { _id: doc._id },
          { $set: { balance: toDecimal128(state.balance), updatedAt: new Date() } },
          { session }
        )
      }
    }

    await this.postings.insertMany(postingDocs, { session });
    await this.entries.insertMany(entryDocs, { session });

    const post: PostPostingContext = {
      operationId: operationId.toHexString(),
      entryIds: entryDocs.map((e) => e._id.toHexString()),
      accountBalance: async (ownerId, currency, walletType) => {
        const b = await this.accountsRepo.balanceBreakdown(
          tenantId, ownerId, currency, walletType, session
        );
        return b!;
      }
    }

    if (legderOperation.sideEffect) await legderOperation.sideEffect(post);
    // A cut-over owner's back-end `wallets` document changes in this same transaction.
    await this.legacyWallets.updateFromLedger(
      tenantId,
      postingDocs.filter((p) => p.kind === 'user').map((p) => ({ ownerId: p.ownerId!, currency: p.currency, walletType: p.walletType! })),
      session,
    );
    const response = await legderOperation.buildResponse(post);
    const events = await legderOperation.buildEvent(post);
    const eventList = Array.isArray(events) ? events : [events];
    for (const [index, event] of eventList.entries()) {
      await this.outboxRepo.write(tenantId, operationId, event, index, session);
    }
    await this.idempotency.insert(
      {
        _id: new Types.ObjectId(),
        tenantId,
        key: args.idempotencyKey,
        requestHash,
        operationType: args.operationType,
        status: 'completed',
        operationId,
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
      for (const posting of entry.postings) {
        if (posting.account.currency !== entry.currency) {
          throw AppError.validation('Posting account currency must match entry currency', {
            entryCurrency: entry.currency,
            accountCurrency: posting.account.currency,
          });
        }
        net += signedDelta(posting.direction, posting.amount);
      }
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

  private async ensureAccounts(
    tenantId: string,
    accountRefs: AccountRef[],
    session: ClientSession
  ): Promise<void> {
    const userAccounts = new Set<string>();
    const systemAccounts: AccountRef[] = [];
    for (const accountRef of accountRefs) {
      if (accountRef.kind === 'user') {
        userAccounts.add(`${accountRef.ownerId}\0${accountRef.currency}\0${accountRef.walletType}`);
      }
      else systemAccounts.push(accountRef);
    }
    for (const key of userAccounts) {
      const [ownerId, currency, walletType] = key.split('\0');
      await this.accountsRepo.ensureUserWallet(
        tenantId, ownerId, currency, walletType as WalletType, session
      )
    }
    for (const sys of systemAccounts) {
      if (sys.kind === 'system') {
        await this.accountsRepo.ensureSystem(tenantId, sys.name, sys.currency, session);
      }
    }
  }

  /** Loads every account the operation touches, keyed by refKey(). */
  private async loadAccounts(
    tenantId: string,
    refs: AccountRef[],
    session: ClientSession,
  ): Promise<Map<string, AccountDoc>> {
    const branches = new Map<string, QueryFilter<AccountDoc>>();
    for (const ref of refs) {
      if (ref.kind === 'user') {
        branches.set(`u\0${ref.ownerId}\0${ref.currency}\0${ref.walletType}`, {
          ownerId: ref.ownerId,
          currency: ref.currency,
          walletType: ref.walletType
        });
      } else {
        branches.set(`s\0${ref.name}\0${ref.currency}`, {
          ownerId: null,
          walletType: null,
          accountType: ref.name,
          currency: ref.currency
        });
      }
    }
    if (branches.size === 0) return new Map();

    const docs = await this.accounts
      .find({ tenantId, $or: [...branches.values()] }, null, { session })
      .lean<AccountDoc[]>()
      .exec();
    return new Map(docs.map((d) => [refKey(refOf(d)), d]))
  }
}

/** Prefix for every log line of one post() call: the operation (collection.receive,
 * payout.initiate, refund.success, ...) plus what identifies it across services. */
function logTag(args: PostArgs<unknown>): string {
  return (
    `[${args.operationType}] reference=${args.reference ?? '-'} ` +
    `tenant=${args.tenantId || '-'} idempotencyKey=${args.idempotencyKey}`
  );
}

function describeResult(response: unknown): string {
  if (!response || typeof response !== 'object') return '';
  const { operationId, entryId, entryIds } = response as Record<string, unknown>;
  return [
    operationId ? `operationId=${operationId}` : '',
    entryId ? `entryId=${entryId}` : '',
    Array.isArray(entryIds) ? `entryIds=${entryIds.join(',')}` : '',
  ].filter(Boolean).join(' ');
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  } catch {
    return String(value);
  }
}

function isTransient(err: unknown): boolean {
  return (
    err instanceof mongo.MongoServerError &&
    (err.hasErrorLabel?.('TransientTransactionError') ||
      err.hasErrorLabel?.('UnknownTransactionCommitResult') ||
      err.codeName === 'WriteConflict'
    )
  );
}

function isDuplicateKey(err: unknown): boolean {
  return err instanceof mongo.MongoServerError && err.code === 11000;
}