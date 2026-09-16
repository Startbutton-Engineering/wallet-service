import { Injectable, OnModuleInit } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { ClientSession, Model, Types } from "mongoose";
import { OutboxDoc, OutboxEventI } from "./types";
import { Outbox } from "./schemas/outbox.schema";

@Injectable()
export class OutboxRepository implements OnModuleInit {
  constructor(@InjectModel(Outbox.name) private readonly model: Model<OutboxDoc>) {}

  async onModuleInit(): Promise<void> {
    await this.model.createCollection().catch(() => undefined);
    await this.model.syncIndexes();
  }

  async write(
    tenantId: string,
    operationId: Types.ObjectId,
    event: OutboxEventI,
    index: number,
    session: ClientSession,
  ): Promise<OutboxDoc> {
    const doc: OutboxDoc = {
      _id: new Types.ObjectId(),
      tenantId,
      type: event.type,
      schemaVersion: event.schemaVersion ?? 1,
      dedupeId: `${operationId.toHexString()}:${event.type}:${index}`,
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