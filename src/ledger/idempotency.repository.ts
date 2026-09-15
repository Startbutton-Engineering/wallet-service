import { Injectable, OnModuleInit } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { createHash } from "crypto";
import { IdempotencyDoc } from "./types";
import { ClientSession } from "mongodb";

const COLLECTION = 'idempotency';

@Injectable()
export class IdempotencyRepository implements OnModuleInit {
  constructor(private readonly db: DatabaseService) {}

  private col() {
    return this.db.collection<IdempotencyDoc>(COLLECTION);
  }

  async onModuleInit(): Promise<void> {
    await this.db.db.createCollection(COLLECTION).catch(() => undefined)
  }

  static hash(operationType: string, payload: unknown): string {
    return createHash('sha256')
      .update(operationType)
      .update('\0')
      .update(stableStringify(payload))
      .digest('hex');
  }

  static id(tenantId: string, key: string): string {
    return `${tenantId}:${key}`;
  }

  async find(tenantId: string, key: string):Promise<IdempotencyDoc | null> {
    return this.col().findOne({ _id: IdempotencyRepository.id(tenantId, key)});
  }

  async insert(doc: IdempotencyDoc, session: ClientSession):Promise<void> {
    await this.col().insertOne(doc, {session} );
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