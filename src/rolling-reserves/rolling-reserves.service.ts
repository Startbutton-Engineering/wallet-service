import { Injectable } from "@nestjs/common";
import { LedgerService } from "../ledger/ledger.service";
import { CurrencyRegistryService } from "../currency/currency-registry.service";
import { balanceToJson } from "../wallets/dto";
import { OutboxEventType } from "../ledger/types";
import { accountRef } from "../accounts/account";
import { AppError } from "../common/errors";
import { creditWithDebtPaydown } from "../collections/credit-policy";

export const RollingReserveOperation = {
  release: 'rolling-reserve.release',
} as const;

export interface RollingReserveReleaseResult {
  operationId: string;
  entryId: string;
  releaseId: string;
  settledToDebit: string;
  amountToCredit: string;
  balance: ReturnType<typeof balanceToJson>;
}

export interface RollingReserveReleaseParams {
  tenantId: string;
  idempotencyKey: string;
  releaseId: string;
  ownerId: string;
  currency: string;
  amount: bigint;
}

@Injectable()
export class RollingReservesService {
  constructor(
    private readonly ledgerService: LedgerService,
    private readonly currencies: CurrencyRegistryService
  ) {}

  /** Hand reserved collection funds back to the owner. A collection only credits its net of the
   * reserve, so the reserved part never left external:collection; releasing it settles straight
   * into the collection wallet, repaying refund-chargeback debt first like any collection credit. */
  async release(params: RollingReserveReleaseParams): Promise<RollingReserveReleaseResult> {
    const { tenantId, idempotencyKey, releaseId, ownerId, currency, amount } = params;
    await this.currencies.require(currency);
    const collectionRail = accountRef.systemCollection(currency);

    return this.ledgerService.post<RollingReserveReleaseResult>({
      tenantId,
      idempotencyKey,
      operationType: RollingReserveOperation.release,
      requestPayload: { releaseId, ownerId, currency, amount: amount.toString() },
      reference: releaseId,
      generateLedgerOps: async (ctx) => {
        const released = await ctx.referenceNetAmount(releaseId, collectionRail, [RollingReserveOperation.release]);
        if (released !== 0n) throw AppError.rollingReserveAlreadyReleased(releaseId);

        const current = await ctx.readBalance(ownerId, currency, 'collection');
        const { postings, settled, amountToCredit } = creditWithDebtPaydown({
          ownerId,
          currency,
          amount,
          refundChargeBackBalance: current.refundChargeback,
        });
        const split = { settledToDebit: settled.toString(), amountToCredit: amountToCredit.toString() };

        return {
          entries: [{
            currency,
            postings: [{ account: collectionRail, direction: 'debit', amount }, ...postings],
          }],
          guardNegative: [],
          buildResponse: async (post) => ({
            operationId: post.operationId,
            entryId: post.entryIds[0],
            releaseId,
            ...split,
            balance: balanceToJson(await post.accountBalance(ownerId, currency, 'collection')),
          }),
          buildEvent: async (post) => {
            const payload = {
              operationId: post.operationId,
              releaseId,
              ownerId,
              currency,
              amount: amount.toString(),
              ...split,
              balance: balanceToJson(await post.accountBalance(ownerId, currency, 'collection')),
            };
            const types = [
              OutboxEventType.ROLLING_RESERVE_RELEASED,
              ...(settled > 0n ? [OutboxEventType.REFUND_CHARGEBACK_SETTLED] : []),
            ];
            return types.map((type) => ({ type, schemaVersion: 1, payload }));
          },
        };
      },
    });
  }
}
