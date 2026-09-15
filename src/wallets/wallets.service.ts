import { Injectable } from "@nestjs/common";
import { WalletBalance } from "./dto";
import { CurrencyRegistryService } from "../currency/currency-registry.service";
import { AccountsRepository } from "../accounts/accounts.repository";
import { AppError } from "../common/errors";

@Injectable()
export class WalletsService {
  constructor(
    private readonly currencyService: CurrencyRegistryService,
    private readonly accounts: AccountsRepository
  ) {}

  async createWallet(tenantId: string, ownerId: string, currency: string): Promise<WalletBalance> {
    await this.currencyService.require(currency);
    await this.accounts.ensureUserWallet(tenantId, ownerId, currency);
    return this.balance(tenantId, ownerId, currency);
  }

  async balance(tenantId: string, ownerId: string, currency: string): Promise<WalletBalance> {
    await this.currencyService.require(currency);
    const breakdown = await this.accounts.balanceBreakdown(tenantId, ownerId, currency);
    if(!breakdown) {
      throw AppError.notFound(`No wallet for owner ${ownerId} in ${currency}`, {
        ownerId, currency
      })
    }
    return breakdown;
  }
}