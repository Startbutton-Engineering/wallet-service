import { Injectable, OnModuleInit } from "@nestjs/common";
import { InjectModel, Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Model, mongo } from "mongoose";

@Schema({ collection: 'locks', versionKey: false })
export class Lock {
  @Prop({ type: String })
  _id: string;

  @Prop({ type: String })
  holderId: string;

  @Prop({ type: Date })
  expiresAt: Date;

  /** When the lease was first ever taken: the scheduler's start of service. */
  @Prop({ type: Date })
  createdAt: Date;
}

export const LockSchema = SchemaFactory.createForClass(Lock);

@Injectable()
export class LeaseRepository implements OnModuleInit {
  constructor(@InjectModel(Lock.name) private readonly locks: Model<Lock>) {}

  async onModuleInit(): Promise<void> {
    await this.locks.createCollection().catch(() => undefined);
  }

  async tryAcquire(name: string, holderId: string, now: Date, ttlMs: number): Promise<boolean> {
    try {
      await this.locks.findOneAndUpdate(
        { _id: name, $or: [{ expiresAt: { $lte: now } }, { holderId }] },
        { $set: { holderId, expiresAt: new Date(now.getTime() + ttlMs) }, $setOnInsert: { createdAt: now } },
        { upsert: true },
      );
      return true;
    } catch (err) {
      if (err instanceof mongo.MongoServerError && err.code === 11000) return false;
      throw err;
    }
  }

  async renew(name: string, holderId: string, now: Date, ttlMs: number): Promise<boolean> {
    const res = await this.locks.updateOne(
      { _id: name, holderId },
      { $set: { expiresAt: new Date(now.getTime() + ttlMs) } },
    );
    return res.matchedCount === 1;
  }

  async firstAcquiredAt(name: string): Promise<Date | null> {
    const lock = await this.locks.findById(name).lean<Lock>().exec();
    return lock?.createdAt ?? null;
  }

  async release(name: string, holderId: string, now: Date): Promise<void> {
    await this.locks.updateOne({ _id: name, holderId }, { $set: { expiresAt: now } });
  }
}
