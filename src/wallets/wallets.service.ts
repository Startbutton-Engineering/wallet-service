import { Injectable } from "@nestjs/common";
import { balanceToJson, WalletBalance } from "./dto";
import { CurrencyRegistryService } from "../currency/currency-registry.service";
import { AccountsRepository } from "../accounts/accounts.repository";
import { AppError } from "../common/errors";
import { accountRef, WALLET_TYPES, WalletType } from "../accounts/account";
import { LedgerService, PostPostingContext } from "../ledger/ledger.service";
import { creditWithDebtPaydown } from "../collections/credit-policy";
import { OutboxEventType } from "../ledger/types";

/** operationType stamped on every wallet-to-wallet transfer posting. Never change this string
 * without a migration — posted history is interpreted through it. */
export const WALLET_TRANSFER_OPERATION = 'wallet.intra-transfer';

export interface WalletTransferResult {
  operationId: string;
  entryId: string;
  transferId: string;
  from: WalletType;
  to: WalletType;
  source: ReturnType<typeof balanceToJson>;
  destination: ReturnType<typeof balanceToJson>;
}

export interface WalletTransferParams {
  tenantId: string;
  idempotencyKey: string;
  transferId: string;
  ownerId: string;
  currency: string;
  amount: bigint;
  from: WalletType;
  to: WalletType;
}

@Injectable()
export class WalletsService {
  constructor(
    private readonly currencyService: CurrencyRegistryService,
    private readonly accounts: AccountsRepository,
    private readonly ledgerService: LedgerService
  ) {}

  /** Move funds between two of the owner's own wallets in one balanced entry. Direction is
   * whatever the caller asks for: collection -> payout to fund payouts, payout -> collection
   * to release float that is no longer needed. Only `available` moves; held and reserved
   * funds are committed elsewhere and stay where they are. */
  async transfer(params: WalletTransferParams): Promise<WalletTransferResult> {
    const { tenantId, idempotencyKey, transferId, ownerId, currency, amount, from, to } = params;
    await this.currencyService.require(currency);

    const source = accountRef.user(ownerId, currency, from, 'available');
    const destination = accountRef.user(ownerId, currency, to, 'available');
    return this.ledgerService.post<WalletTransferResult>({
      tenantId,
      idempotencyKey,
      operationType: WALLET_TRANSFER_OPERATION,
      requestPayload: { transferId, ownerId, currency, amount: amount.toString(), from, to },
      reference: transferId,
      generateLedgerOps: async (ctx) => {
        // Checked on the source: a collection destination may receive nothing in `available`
        // when the whole amount goes to refund-chargeback debt.
        const alreadyApplied = await ctx.referenceNetAmount(transferId, source, [
          WALLET_TRANSFER_OPERATION,
        ]);
        if (alreadyApplied !== 0n) throw AppError.walletTransferAlreadyApplied(transferId);

        // Money arriving in a collection wallet repays refund/chargeback debt first, as any
        // other collection-wallet credit does.
        const { postings: credits, settled, amountToCredit } = to === 'collection'
          ? creditWithDebtPaydown({
              ownerId,
              currency,
              amount,
              refundChargeBackBalance: (await ctx.readBalance(ownerId, currency, 'collection')).refundChargeback,
            })
          : {
              postings: [{ account: destination, direction: 'credit' as const, amount }],
              settled: 0n,
              amountToCredit: amount,
            };

        const eventPayload = async (post: PostPostingContext) => ({
          operationId: post.operationId,
          transferId,
          ownerId,
          currency,
          amount: amount.toString(),
          from,
          to,
          settledToDebit: settled.toString(),
          amountToCredit: amountToCredit.toString(),
          source: balanceToJson(await post.accountBalance(ownerId, currency, from)),
          destination: balanceToJson(await post.accountBalance(ownerId, currency, to)),
        });

        return {
          entries: [{
            currency,
            postings: [
              { account: source, direction: 'debit', amount },
              ...credits,
            ],
          }],
          guardNegative: [source],
          buildResponse: async (post) => ({
            operationId: post.operationId,
            entryId: post.entryIds[0],
            transferId,
            from,
            to,
            source: balanceToJson(await post.accountBalance(ownerId, currency, from)),
            destination: balanceToJson(await post.accountBalance(ownerId, currency, to)),
          }),
          buildEvent: async (post) => {
            const payload = await eventPayload(post);
            return [
              OutboxEventType.WALLET_TRANSFERRED,
              ...(settled > 0n ? [OutboxEventType.REFUND_CHARGEBACK_SETTLED] : []),
            ].map((type) => ({ type, schemaVersion: 1, payload }));
          },
        };
      },
    });
  }

  async createWallet(
    tenantId: string,
    ownerId: string,
    currency: string,
    walletType: WalletType
  ): Promise<WalletBalance> {
    await this.currencyService.require(currency);
    await this.accounts.ensureUserWallet(tenantId, ownerId, currency, walletType);
    return this.walletBalance(tenantId, ownerId, currency, walletType);
  }

  async walletBalance(
    tenantId: string,
    ownerId: string,
    currency: string,
    walletType: WalletType
  ): Promise<WalletBalance> {
    await this.currencyService.require(currency);
    const breakdown = await this.accounts.balanceBreakdown(tenantId, ownerId, currency, walletType);
    if(!breakdown) {
      throw AppError.notFound(`No ${walletType} wallet for owner ${ownerId} in ${currency}`, {
        ownerId, currency, walletType
      })
    }
    return breakdown;
  }

  /** Every wallet the owner holds in this currency, one entry per provisioned wallet type
   * in WALLET_TYPES order. A type the owner was never provisioned for is absent rather than
   * a zeroed entry. Only 404s when the owner has no wallet at all in this currency. */
  async balances(tenantId: string, ownerId: string, currency: string): Promise<WalletBalance[]> {
    await this.currencyService.require(currency);
    const breakdowns = await Promise.all(
      WALLET_TYPES.map((walletType) =>
        this.accounts.balanceBreakdown(tenantId, ownerId, currency, walletType)
      )
    );
    const wallets = breakdowns.filter((b): b is WalletBalance => b !== null);
    if (wallets.length === 0) {
      throw AppError.notFound(`No wallet for owner ${ownerId} in ${currency}`, {
        ownerId, currency
      })
    }
    return wallets;
  }
}
