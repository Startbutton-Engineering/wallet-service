import { Injectable } from "@nestjs/common";
import { AccountsRepository } from "../accounts/accounts.repository";
import { UserAccountTpe, WalletType } from "../accounts/account";
import { AppError } from "../common/errors";
import { CursorPosition, cursorFingerprint, decodeCursor, encodeCursor } from "../common/cursor";
import { CurrencyRegistryService } from "../currency/currency-registry.service";
import { PostingsRepository } from "../ledger/postings.repository";
import { PostingDoc } from "../ledger/types";
import { StatementPage, statementRow } from "./dto";

export interface StatementParams {
  tenantId: string;
  ownerId: string;
  currency: string;
  walletType?: WalletType;
  accountType?: UserAccountTpe;
  from?: Date;
  to?: Date;
  limit: number;
  cursor?: string;
}

const EMPTY: StatementPage = { items: [], nextCursor: null };

@Injectable()
export class StatementService {
  constructor(
    private readonly currencies: CurrencyRegistryService,
    private readonly accounts: AccountsRepository,
    private readonly postings: PostingsRepository
  ) {}

  async statement(p: StatementParams): Promise<StatementPage> {
    await this.currencies.require(p.currency);

    const accounts = await this.accounts.findUserAccounts(p.tenantId, p.ownerId, p.currency, p.walletType);
    if (accounts.length === 0) {
      throw AppError.notFound(
        p.walletType
          ? `No ${p.walletType} wallet for owner ${p.ownerId} in ${p.currency}`
          : `No wallet for owner ${p.ownerId} in ${p.currency}`,
        { ownerId: p.ownerId, currency: p.currency, ...(p.walletType ? { walletType: p.walletType } : {}) }
      );
    }

    const fingerprint = cursorFingerprint([
      p.ownerId,
      p.currency,
      p.walletType ?? null,
      p.accountType ?? null,
      p.from?.toISOString() ?? null,
      p.to?.toISOString() ?? null,
    ]);
    const position = p.cursor ? decodeCursor(p.cursor, fingerprint) : null;
    const singleAccount = Boolean(p.walletType && p.accountType);
    // Fetch one extra row: its presence is what says another page exists.
    const fetch = p.limit + 1;

    let rows: PostingDoc[];
    if (singleAccount) {
      if (position && position.mode !== 'sequence') throw AppError.validation('Invalid cursor');
      const account = accounts.find((a) => a.accountType === p.accountType);
      if (!account) {
        throw AppError.notFound(`No ${p.accountType} account in owner ${p.ownerId}'s ${p.walletType} wallet`, {
          ownerId: p.ownerId, currency: p.currency, walletType: p.walletType, accountType: p.accountType,
        });
      }
      const bounds = await this.postings.sequenceBounds(account._id, p.from, p.to);
      if (!bounds) return EMPTY;
      rows = await this.postings.pageByAccount({
        accountId: account._id,
        ...bounds,
        afterSeq: position?.mode === 'sequence' ? position.sequence : undefined,
        limit: fetch,
      });
    } else {
      if (position && position.mode !== 'time') throw AppError.validation('Invalid cursor');
      rows = await this.postings.pageByOwner({
        tenantId: p.tenantId,
        ownerId: p.ownerId,
        currency: p.currency,
        walletType: p.walletType,
        accountType: p.accountType,
        from: p.from,
        to: p.to,
        after: position?.mode === 'time' ? { createdAt: position.createdAt, id: position.id } : undefined,
        limit: fetch,
      });
    }

    const page = rows.slice(0, p.limit);
    const last = page.at(-1);
    const nextCursor =
      rows.length > p.limit && last ? encodeCursor(positionOf(last, singleAccount), fingerprint) : null;
    return { items: page.map(statementRow), nextCursor };
  }
}

function positionOf(row: PostingDoc, singleAccount: boolean): CursorPosition {
  return singleAccount
    ? { mode: 'sequence', sequence: row.sequence! }
    : { mode: 'time', createdAt: row.createdAt, id: row._id.toHexString() };
}
