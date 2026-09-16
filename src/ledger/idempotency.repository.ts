import { Injectable, OnModuleInit } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { ClientSession, Model } from "mongoose";
import { createHash } from "crypto";
import { IdempotencyDoc } from "./types";
import { Idempotency } from "./schemas/idempotency.schema";

@Injectable()
export class IdempotencyRepository implements OnModuleInit {
  constructor(
    @InjectModel(Idempotency.name) private readonly model: Model<IdempotencyDoc>
  ) {}

  async onModuleInit(): Promise<void> {
    await this.model.createCollection().catch(() => undefined)
    await this.model.syncIndexes();
  }

  static hash(operationType: string, payload: unknown): string {
    return createHash('sha256')
      .update(operationType)
      .update('\0')
      .update(stableStringify(payload))
      .digest('hex');
  }

  async find(tenantId: string, key: string):Promise<IdempotencyDoc | null> {
    return this.model
      .findOne({ tenantId, key })
      .lean<IdempotencyDoc>()
      .exec();
  }

  async insert(doc: IdempotencyDoc, session: ClientSession):Promise<void> {
    await this.model.create([doc], { session });
  }

}

/** Deterministic JSON so semantically-equal payloads hash identically. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}