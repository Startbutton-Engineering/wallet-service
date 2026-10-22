import { Types } from 'mongoose';
import { CutoverService } from '../../../src/migrations/cutover.service';
import { AppError, ErrorCode } from '../../../src/common/errors';
import type { MigrationDoc } from '../../../src/migrations/migration.schema';

const migration = (overrides: Partial<MigrationDoc> = {}): MigrationDoc => ({
  _id: new Types.ObjectId(), tenantId: 't1', type: 'cutover', ownerId: 'owner-1', idempotencyKey: 'key-1',
  status: 'pending', attempts: 0, result: null, error: null,
  createdAt: new Date(), updatedAt: new Date(), startedAt: null, finishedAt: null,
  ...overrides,
});

function build() {
  const ledger = { post: jest.fn() };
  const migrations = {
    findByKey: jest.fn(), create: jest.fn(), requeue: jest.fn(), markProcessing: jest.fn(), markFailed: jest.fn(), markCompleted: jest.fn(),
  };
  const queue = { publish: jest.fn(async () => undefined), consume: jest.fn() };
  const legacyWallets = { isCutOver: jest.fn(async () => false) };
  const service = new CutoverService(ledger as never, {} as never, legacyWallets as never, migrations as never, queue as never);
  // Reading the legacy wallets is covered end to end.
  jest.spyOn(service as never, 'readLegacyWallets').mockResolvedValue([] as never);
  return { service, ledger, migrations, queue };
}

describe('CutoverService', () => {
  it('returns the winner\'s record when a concurrent request creates it first', async () => {
    const { service, migrations, queue } = build();
    const winner = migration();
    migrations.findByKey.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
    migrations.create.mockResolvedValue(null);
    migrations.requeue.mockResolvedValue(winner);

    const view = await service.request('t1', 'key-1', 'owner-1');

    expect(view.operationId).toBe(winner._id.toHexString());
    expect(queue.publish).toHaveBeenCalledWith('wallet-service.ledger-cutover', { operationId: winner._id.toHexString() });
  });

  it('records a non-Error failure as a retryable internal error on the last attempt', async () => {
    const { service, ledger, migrations } = build();
    const doc = migration();
    migrations.markProcessing.mockResolvedValue(doc);
    ledger.post.mockRejectedValue('boom');

    await service.process({ operationId: doc._id.toHexString() }, { retries: 3, lastAttempt: true });

    expect(migrations.markFailed).toHaveBeenCalledWith(doc._id, { code: ErrorCode.INTERNAL_ERROR, message: 'boom', retryable: true });
  });

  it('records a rejection without details as it is', async () => {
    const { service, ledger, migrations } = build();
    const doc = migration();
    migrations.markProcessing.mockResolvedValue(doc);
    ledger.post.mockRejectedValue(AppError.validation('bad'));

    await service.process({ operationId: doc._id.toHexString() }, { retries: 0, lastAttempt: false });

    expect(migrations.markFailed).toHaveBeenCalledWith(doc._id, { code: ErrorCode.VALIDATION_FAILED, message: 'bad', retryable: false });
  });
});
