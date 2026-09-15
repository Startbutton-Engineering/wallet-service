import { Injectable, OnModuleInit } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { ClientSession, Model } from "mongoose";
import { OutboxDoc, OutboxEventI } from "./types";
import { Outbox } from "./schemas/outbox.schema";
import { randomUUID } from "crypto";

@Injectable()
export class OutboxRepository implements OnModuleInit {
  constructor(@InjectModel(Outbox.name) private readonly model: Model<OutboxDoc>) {}

  async onModuleInit(): Promise<void> {
    await this.model.createCollection().catch(() => undefined);
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
    await this.model.create([doc], { session });
    return doc;
  }
}