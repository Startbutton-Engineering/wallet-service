import { Injectable, OnModuleInit } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { OutboxDoc, OutboxEventI } from "./types";
import { ClientSession } from "mongodb";
import { randomUUID } from "crypto";

const COLLECTION = 'outbox';

@Injectable()
export class OutboxRepository implements OnModuleInit {
  constructor(private readonly db: DatabaseService) {}

  private col() {
    return this.db.collection<OutboxDoc>(COLLECTION);
  }

  async onModuleInit(): Promise<void> {
    await this.db.db.createCollection(COLLECTION).catch(() => undefined);
    await this.col().createIndex({ published: 1, createdAt: 1 });
  }

  async write(
    tenantId: string,
    operationId: string,
    event: OutboxEventI,
    session: ClientSession,
  ): Promise<OutboxDoc> {
    const doc: OutboxDoc = {
      _id: randomUUID(),
      tenantId,
      type: event.type,
      schemaVersion: event.schemaVersion ?? 1,
      dedupeId: randomUUID(),
      operationId,
      payload: event.payload,
      published: false,
      publishedAt: null,
      createdAt: new Date()
    }
    await this.col().insertOne(doc, { session });
    return doc;
  }
}