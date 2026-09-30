import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { WalletsService } from "./wallets.service";
import { TenantId } from "../common/tenant.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { balanceToJson, createWalletSchema, statementQuerySchema, walletTransferSchema } from "./dto";
import { ResponseMessage } from "../common/api-response";
import { IdempotencyKey } from "../common/idempotency-key.decorator";
import type { CreateWalletDto, StatementQueryDto, WalletTransferDto } from "./dto"
import { StatementService } from "./statement.service";

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly walletsService: WalletsService,
    private readonly statementService: StatementService
  ) {}

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

  @Post('transfer')
  @ResponseMessage('Wallet transfer applied')
  async transfer(
    @TenantId() tenantId: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body(new ZodValidationPipe(walletTransferSchema)) body: WalletTransferDto
  ) {
    return await this.walletsService.transfer({
      tenantId,
      idempotencyKey,
      transferId: body.transferId,
      ownerId: body.ownerId,
      currency: body.currency,
      amount: BigInt(body.amount),
      from: body.from,
      to: body.to,
    })
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

  @Get(':ownerId/:currency/statement')
  @ResponseMessage('Wallet statement retrieved')
  async statement(
    @TenantId() tenantId: string,
    @Param('ownerId') ownerId: string,
    @Param('currency') currency: string,
    @Query(new ZodValidationPipe(statementQuerySchema)) query: StatementQueryDto,
  ) {
    return await this.statementService.statement({ tenantId, ownerId, currency, ...query });
  }
}
