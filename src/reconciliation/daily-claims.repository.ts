import { Injectable, OnModuleInit } from "@nestjs/common";
import { InjectModel, Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Model, mongo, SchemaTypes, Types } from "mongoose";

export type AttemptOutcome = 'completed' | 'abandoned' | 'failed';

export interface Attempt {
  attempt: number;
  holderId: string;
  startedAt: Date;
  endedAt: Date | null;
  outcome: AttemptOutcome | null;
  error: string | null;
}

@Schema({ collection: 'reconciliationDailyClaims', versionKey: false })
export class DailyClaim {
  @Prop({ type: String })
  _id: string;

  @Prop({ type: String })
  status: 'running' | 'completed' | 'failed';

  @Prop({ type: Number })
  attempt: number;

  @Prop({ type: [SchemaTypes.Mixed] })
  attempts: Attempt[];

  @Prop({ type: SchemaTypes.ObjectId, default: null })
  runId: Types.ObjectId | null;
}

export const DailyClaimSchema = SchemaFactory.createForClass(DailyClaim);

@Injectable()
export class DailyClaimsRepository implements OnModuleInit {
  constructor(@InjectModel(DailyClaim.name) private readonly claims: Model<DailyClaim>) {}

  async onModuleInit(): Promise<void> {
    await this.claims.createCollection().catch(() => undefined);
  }

  async isCompleted(runDate: string): Promise<boolean> {
    return (await this.claims.exists({ _id: runDate, status: 'completed' })) !== null;
  }

  async begin(runDate: string, holderId: string, now: Date): Promise<number | null> {
    const claim = await this.claims.findById(runDate).lean<DailyClaim>().exec();
    const next: Attempt = { attempt: 1, holderId, startedAt: now, endedAt: null, outcome: null, error: null };
    if (!claim) {
      try {
        await this.claims.create({ _id: runDate, status: 'running', attempt: 1, attempts: [next], runId: null });
        return 1;
      } catch (err) {
        if (err instanceof mongo.MongoServerError && err.code === 11000) return null;
        throw err;
      }
    }
    if (claim.status === 'completed') return null;

    const attempt = claim.attempt + 1;
    const attempts = claim.attempts.map((a) =>
      a.attempt === claim.attempt && a.outcome === null ? { ...a, endedAt: now, outcome: 'abandoned' as const } : a,
    );
    const res = await this.claims.updateOne(
      { _id: runDate, attempt: claim.attempt },
      { $set: { status: 'running', attempt, attempts: [...attempts, { ...next, attempt }] } },
    );
    return res.matchedCount === 1 ? attempt : null;
  }

  async complete(runDate: string, attempt: number, runId: Types.ObjectId, now: Date): Promise<void> {
    await this.claims.updateOne(
      { _id: runDate, attempt },
      { $set: { status: 'completed', runId, 'attempts.$[a].endedAt': now, 'attempts.$[a].outcome': 'completed' } },
      { arrayFilters: [{ 'a.attempt': attempt }] },
    );
  }

  async fail(runDate: string, attempt: number, error: string, now: Date): Promise<void> {
    await this.claims.updateOne(
      { _id: runDate, attempt },
      {
        $set: {
          status: 'failed',
          'attempts.$[a].endedAt': now,
          'attempts.$[a].outcome': 'failed',
          'attempts.$[a].error': error,
        },
      },
      { arrayFilters: [{ 'a.attempt': attempt }] },
    );
  }
}
