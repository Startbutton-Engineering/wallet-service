import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { WalletsService } from "./wallets.service";
import { TenantId } from "../common/tenant.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { balanceToJson, createWalletSchema } from "./dto";
import type { CreateWalletDto } from "./dto"

@Controller('wallets')
export class WalletsController {
  constructor(private readonly walletsService: WalletsService) {}

  @Post()
  async create(
    @TenantId() tenantId: string,
    @Body(new ZodValidationPipe(createWalletSchema)) body: CreateWalletDto
  ) {
    const balance = await this.walletsService.createWallet(tenantId, body.ownerId, body.currency);
    return balanceToJson(balance)
  }

  @Get(':ownerId/balance/:currency')
  async balance(
    @TenantId() tenantId: string,
    @Param('ownerId') ownerId: string,
    @Param('currency') currency: string,
  ) {
    const balance = await this.walletsService.balance(tenantId, ownerId, currency);
    return balanceToJson(balance);
  }
}