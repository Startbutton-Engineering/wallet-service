import { ClientSession } from 'mongoose';
import {
  LedgerOperation,
  LedgerService,
  PostArgs,
  PostPostingContext,
  PrePostContext,
} from '../../src/ledger/ledger.service';
import { OutboxEventI } from '../../src/ledger/types';
import { AccountRef, WalletType } from '../../src/accounts/account';
import { WalletBalance } from '../../src/wallets/dto';
import { CurrencyRegistryService } from '../../src/currency/currency-registry.service';
import { AccountsRepository } from '../../src/accounts/accounts.repository';
import { AppError } from '../../src/common/errors';
import { Currency } from '../../src/currency/currency';
import { walletBalance } from './fixtures';

export interface LedgerHarnessOptions {
  /** Answer for `ctx.readBalance` / `post.accountBalance`; defaults to an all-zero wallet. */
  balance?: (ownerId: string, currency: string, walletType: WalletType) => WalletBalance;
  /** Answer for `ctx.referenceNetAmount`; defaults to 0n (nothing posted yet). */
  netAmount?: (reference: string, account: AccountRef, operationTypes?: string[]) => bigint;
  /** Answer for `ctx.referenceEntryIds`; defaults to none. */
  entryIdsFor?: (reference: string, operationType: string) => string[];
  operationId?: string;
}

/** A LedgerService stand-in that runs the caller's `generateLedgerOps` for real.
 *
 * Everything the services build — postings, guards, the response and the outbox events —
 * is produced by the code under test and captured here, so a service test asserts on the
 * plan itself without a database. */
export class LedgerHarness {
  readonly operationId: string;
  /** Every `post()` call, newest last. */
  readonly calls: PostArgs<any>[] = [];
  /** The LedgerOperation each `post()` call produced. */
  readonly operations: LedgerOperation<any>[] = [];
  /** Outbox events emitted, flattened across calls. */
  readonly events: OutboxEventI[] = [];
  sideEffects = 0;

  readonly readBalance: jest.Mock;
  readonly referenceNetAmount: jest.Mock;
  readonly referenceEntryIds: jest.Mock;
  readonly accountBalance: jest.Mock;
  readonly post: jest.Mock;

  constructor(options: LedgerHarnessOptions = {}) {
    this.operationId = options.operationId ?? 'op-1';
    const balance = options.balance ?? ((ownerId, currency, walletType) =>
      walletBalance({ ownerId, currency, walletType }));

    this.readBalance = jest.fn(async (...args: [string, string, WalletType]) => balance(...args));
    this.accountBalance = jest.fn(async (...args: [string, string, WalletType]) => balance(...args));
    this.referenceNetAmount = jest.fn(async (reference: string, account: AccountRef, types?: string[]) =>
      options.netAmount ? options.netAmount(reference, account, types) : 0n,
    );
    this.referenceEntryIds = jest.fn(async (reference: string, operationType: string) =>
      options.entryIdsFor ? options.entryIdsFor(reference, operationType) : [],
    );
    this.post = jest.fn((args: PostArgs<any>) => this.run(args));
  }

  private async run<T>(args: PostArgs<T>): Promise<T> {
    this.calls.push(args);

    const pre: PrePostContext = {
      session: {} as ClientSession,
      readBalance: this.readBalance as PrePostContext['readBalance'],
      referenceNetAmount: this.referenceNetAmount as PrePostContext['referenceNetAmount'],
      referenceEntryIds: this.referenceEntryIds as PrePostContext['referenceEntryIds'],
    };

    const operation = await args.generateLedgerOps(pre);
    this.operations.push(operation);

    const post: PostPostingContext = {
      operationId: this.operationId,
      entryIds: operation.entries.map((_, index) => `entry-${index + 1}`),
      accountBalance: this.accountBalance as PostPostingContext['accountBalance'],
    };

    if (operation.sideEffect) {
      await operation.sideEffect(post);
      this.sideEffects += 1;
    }
    const response = await operation.buildResponse(post);
    const emitted = await operation.buildEvent(post);
    this.events.push(...(Array.isArray(emitted) ? emitted : [emitted]));
    return response;
  }

  /** The args of the most recent `post()` call. */
  get lastCall(): PostArgs<any> {
    return this.calls[this.calls.length - 1];
  }

  /** The LedgerOperation of the most recent `post()` call. */
  get lastOperation(): LedgerOperation<any> {
    return this.operations[this.operations.length - 1];
  }

  get service(): LedgerService {
    return this as unknown as LedgerService;
  }
}

export interface MockCurrencyRegistry {
  require: jest.Mock;
  get: jest.Mock;
  list: jest.Mock;
  register: jest.Mock;
  asService: CurrencyRegistryService;
}

/** A currency registry that accepts every code by default.
 * `mockCurrencyRegistry({ known: ['NGN'] })` makes everything else 400 with INVALID_CURRENCY. */
export function mockCurrencyRegistry(options: { known?: string[] } = {}): MockCurrencyRegistry {
  const currency = (code: string): Currency => ({ code, scale: 2, type: 'fiat' });
  const isKnown = (code: string) => !options.known || options.known.includes(code);

  const registry = {
    require: jest.fn(async (code: string) => {
      if (!isKnown(code)) throw AppError.invalidCurrency(code);
      return currency(code);
    }),
    get: jest.fn(async (code: string) => (isKnown(code) ? currency(code) : null)),
    list: jest.fn(async () => (options.known ?? ['NGN']).map(currency)),
    register: jest.fn(async (input: Currency) => input),
  } as unknown as MockCurrencyRegistry;
  registry.asService = registry as unknown as CurrencyRegistryService;
  return registry;
}

export interface MockAccountsRepository {
  ensureUserWallet: jest.Mock;
  ensureSystem: jest.Mock;
  findById: jest.Mock;
  exists: jest.Mock;
  balanceBreakdown: jest.Mock;
  asRepository: AccountsRepository;
}

/** An AccountsRepository stand-in. `balanceBreakdown` resolves null by default —
 * the "wallet was never provisioned" case the services turn into a 404. */
export function mockAccountsRepository(
  balanceBreakdown: (
    tenantId: string,
    ownerId: string,
    currency: string,
    walletType: WalletType,
  ) => WalletBalance | null = () => null,
): MockAccountsRepository {
  const repo = {
    ensureUserWallet: jest.fn(async () => undefined),
    ensureSystem: jest.fn(async () => undefined),
    findById: jest.fn(async () => null),
    exists: jest.fn(async () => false),
    balanceBreakdown: jest.fn(async (...args: [string, string, string, WalletType]) =>
      balanceBreakdown(...args),
    ),
  } as unknown as MockAccountsRepository;
  repo.asRepository = repo as unknown as AccountsRepository;
  return repo;
}
