import { OutboxRepository } from '../../../src/ledger/outbox.repository';
import { OutboxDoc, OutboxEventType } from '../../../src/ledger/types';
import { MockModel, TENANT, mockModel, mockSession } from '../../mocks';

describe('OutboxRepository', () => {
  let model: MockModel<OutboxDoc>;
  let repo: OutboxRepository;
  let session: ReturnType<typeof mockSession>;

  beforeEach(() => {
    model = mockModel<OutboxDoc>();
    session = mockSession();
    repo = new OutboxRepository(model.asModel);
  });

  it('creates its collection on boot and tolerates it already existing', async () => {
    await repo.onModuleInit();
    expect(model.createCollection).toHaveBeenCalled();

    model.createCollection.mockRejectedValue(new Error('exists'));
    await expect(repo.onModuleInit()).resolves.toBeUndefined();
  });

  it('writes an unpublished event inside the caller transaction', async () => {
    const doc = await repo.write(
      TENANT,
      'op-1',
      { type: OutboxEventType.COLLECTION_RECEIVED, schemaVersion: 2, payload: { a: 1 } },
      session.asSession,
    );

    expect(doc).toMatchObject({
      tenantId: TENANT,
      type: OutboxEventType.COLLECTION_RECEIVED,
      schemaVersion: 2,
      operationId: 'op-1',
      payload: { a: 1 },
      published: false,
      publishedAt: null,
    });
    expect(doc.createdAt).toBeInstanceOf(Date);
    expect(model.create).toHaveBeenCalledWith([doc], { session: session.asSession });
  });

  it('defaults the schema version to 1', async () => {
    const doc = await repo.write(TENANT, 'op-1', { type: 'X', payload: {} }, session.asSession);
    expect(doc.schemaVersion).toBe(1);
  });

  it('gives every event its own id and dedupe id', async () => {
    const first = await repo.write(TENANT, 'op-1', { type: 'X', payload: {} }, session.asSession);
    const second = await repo.write(TENANT, 'op-1', { type: 'X', payload: {} }, session.asSession);

    expect(first._id).not.toBe(second._id);
    expect(first.dedupeId).not.toBe(second.dedupeId);
    expect(first._id).not.toBe(first.dedupeId);
  });

  it('keeps the same operationId across the events of one operation', async () => {
    const first = await repo.write(TENANT, 'op-1', { type: 'A', payload: {} }, session.asSession);
    const second = await repo.write(TENANT, 'op-1', { type: 'B', payload: {} }, session.asSession);
    expect([first.operationId, second.operationId]).toEqual(['op-1', 'op-1']);
  });
});
