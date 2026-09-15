import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { WalletsService } from "./wallets.service";
import { TenantId } from "../common/tenant.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { balanceToJson, createWalletSchema } from "./dto";
import { ResponseMessage } from "../common/api-response";
import type { CreateWalletDto } from "./dto"

@Controller('wallets')
export class WalletsController {
  constructor(private readonly walletsService: WalletsService) {}

  @Post()
  @ResponseMessage('Wallet created')
  async create(
    @TenantId() tenantId: string,
    @Body(new ZodValidationPipe(createWalletSchema)) body: CreateWalletDto
  ) {
    const balance = await this.walletsService.createWallet(
      tenantId,
      body.ownerId,
      body.currency,
      body.walletType
    );
    return balanceToJson(balance)
  }

  @Get(':ownerId/balance/:currency')
  @ResponseMessage('Wallet balances retrieved')
  async balance(
    @TenantId() tenantId: string,
    @Param('ownerId') ownerId: string,
    @Param('currency') currency: string,
  ) {
    const balances = await this.walletsService.balances(tenantId, ownerId, currency);
    return balances.map(balanceToJson);
  }
}
