import { Injectable } from "@nestjs/common";
import { WalletBalance } from "./dto";
import { CurrencyRegistryService } from "../currency/currency-registry.service";
import { AccountsRepository } from "../accounts/accounts.repository";
import { AppError } from "../common/errors";
import { WALLET_TYPES, WalletType } from "../accounts/account";

@Injectable()
export class WalletsService {
  constructor(
    private readonly currencyService: CurrencyRegistryService,
    private readonly accounts: AccountsRepository
  ) {}

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
