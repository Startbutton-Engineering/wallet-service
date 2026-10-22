import { Injectable, OnModuleInit } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { Migration, MigrationDoc, MigrationError } from "./migration.schema";
import type { CutoverResult } from "./cutover.service";

@Injectable()
export class MigrationsRepository implements OnModuleInit {
  constructor(@InjectModel(Migration.name) private readonly migrations: Model<MigrationDoc>) {}

  async onModuleInit(): Promise<void> {
    await this.migrations.createCollection().catch(() => undefined);
    await this.migrations.syncIndexes();
  }

  /** A new pending cutover, or null when another request took this key first. */
  async create(tenantId: string, idempotencyKey: string, ownerId: string): Promise<MigrationDoc | null> {
    const now = new Date();
    const doc: MigrationDoc = {
      _id: new Types.ObjectId(),
      tenantId,
      type: 'cutover',
      ownerId,
      idempotencyKey,
      status: 'pending',
      attempts: 0,
      result: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
    };
    try {
      await this.migrations.create(doc);
      return doc;
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return null;
      throw err;
    }
  }

  findByKey(tenantId: string, idempotencyKey: string): Promise<MigrationDoc | null> {
    return this.migrations.findOne({ tenantId, idempotencyKey }).lean<MigrationDoc>().exec();
  }

  /** Tenant-scoped when a tenant is given; the consumer reads by id alone. */
  get(operationId: string, tenantId?: string): Promise<MigrationDoc | null> {
    if (!Types.ObjectId.isValid(operationId)) return Promise.resolve(null);
    const filter = { _id: new Types.ObjectId(operationId), ...(tenantId === undefined ? {} : { tenantId }) };
    return this.migrations.findOne(filter).lean<MigrationDoc>().exec();
  }

  markProcessing(id: Types.ObjectId): Promise<MigrationDoc | null> {
    const now = new Date();
    return this.migrations
      .findOneAndUpdate(
        { _id: id, status: { $in: ['pending', 'processing'] } },
        { $set: { status: 'processing', startedAt: now, updatedAt: now }, $inc: { attempts: 1 } },
        { returnDocument: 'after' },
      )
      .lean<MigrationDoc>()
      .exec();
  }

  async markCompleted(id: Types.ObjectId, result: CutoverResult): Promise<void> {
    const now = new Date();
    await this.migrations.updateOne(
      { _id: id },
      { $set: { status: 'completed', result, error: null, finishedAt: now, updatedAt: now } },
    );
  }

  /** A completed record is final: a late failure from a duplicate delivery never overwrites it. */
  async markFailed(id: Types.ObjectId, error: MigrationError): Promise<void> {
    const now = new Date();
    await this.migrations.updateOne(
      { _id: id, status: { $ne: 'completed' } },
      { $set: { status: 'failed', error, finishedAt: now, updatedAt: now } },
    );
  }

  /** Puts a failed cutover back in line; anything else comes back unchanged. */
  async requeue(id: Types.ObjectId): Promise<MigrationDoc | null> {
    await this.migrations.updateOne(
      { _id: id, status: 'failed' },
      { $set: { status: 'pending', error: null, finishedAt: null, updatedAt: new Date() } },
    );
    return this.migrations.findById(id).lean<MigrationDoc>().exec();
  }
}
