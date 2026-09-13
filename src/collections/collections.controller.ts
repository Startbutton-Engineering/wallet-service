import { Body, Controller, Post } from "@nestjs/common";
import { CollectionsService } from "./collection.service";
import { TenantId } from "../common/tenant.decorator";
import { IdempotencyKey } from "../common/idempotency-key.decorator";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { collectionSchema } from "./dto";
import type { CollectionDto } from './dto';

@Controller('collections')
export class CollectionsController {
  constructor(private readonly collections: CollectionsService) {}

  @Post('collect')
  async collect(
    @TenantId() tenantId: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body(new ZodValidationPipe(collectionSchema)) body: CollectionDto
  ) {
    return await this.collections.collect({
      tenantId,
      idempotencyKey,
      collectionId: body.collectionId,
      ownerId: body.ownerId,
      currency: body.currency,
      amount: BigInt(body.amount),
    })
  }

  @Post('settle')
  async settle(
    @TenantId() tenantId: string,
    @IdempotencyKey() idempotencyKey: string,
    @Body(new ZodValidationPipe(collectionSchema)) body: CollectionDto
  ) {
    return await this.collections.settled({
      tenantId,
      idempotencyKey,
      collectionId: body.collectionId,
      ownerId: body.ownerId,
      currency: body.currency,
      amount: BigInt(body.amount),
    })
  }
}