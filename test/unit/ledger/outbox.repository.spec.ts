import { OutboxRepository } from '../../../src/ledger/outbox.repository';
import { OutboxDoc, OutboxEventType } from '../../../src/ledger/types';
import { Types } from 'mongoose';
import { MockModel, TENANT, mockModel, mockSession } from '../../mocks';

const OP = new Types.ObjectId();

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
      OP,
      { type: OutboxEventType.COLLECTION_RECEIVED, schemaVersion: 2, payload: { a: 1 } },
      0,
      session.asSession,
    );

    expect(doc).toMatchObject({
      tenantId: TENANT,
      type: OutboxEventType.COLLECTION_RECEIVED,
      schemaVersion: 2,
      operationId: OP,
      payload: { a: 1 },
      published: false,
      publishedAt: null,
    });
    expect(doc.createdAt).toBeInstanceOf(Date);
    expect(model.create).toHaveBeenCalledWith([doc], { session: session.asSession });
  });

  it('defaults the schema version to 1', async () => {
    const doc = await repo.write(TENANT, OP, { type: 'X', payload: {} }, 0, session.asSession);
    expect(doc.schemaVersion).toBe(1);
  });

  it('gives every event its own id and dedupe id', async () => {
    // Two events of the SAME type in one operation — the case the index alone disambiguates.
    const first = await repo.write(TENANT, OP, { type: 'X', payload: {} }, 0, session.asSession);
    const second = await repo.write(TENANT, OP, { type: 'X', payload: {} }, 1, session.asSession);

    // String()/equals(), not toBe(): distinct ObjectId instances always differ by reference,
    // which would make a toBe() assertion here vacuously true.
    expect(String(first._id)).not.toBe(String(second._id));
    expect(first.dedupeId).not.toBe(second.dedupeId);
    expect(String(first._id)).not.toBe(first.dedupeId);
  });

  it('derives dedupeId deterministically from the operation, type and index', async () => {
    const doc = await repo.write(TENANT, OP, { type: 'X', payload: {} }, 2, session.asSession);
    expect(doc.dedupeId).toBe(`${OP.toHexString()}:X:2`);

    const again = await repo.write(TENANT, OP, { type: 'X', payload: {} }, 2, session.asSession);
    expect(again.dedupeId).toBe(doc.dedupeId);
  });

  it('keeps the same operationId across the events of one operation', async () => {
    const first = await repo.write(TENANT, OP, { type: 'A', payload: {} }, 0, session.asSession);
    const second = await repo.write(TENANT, OP, { type: 'B', payload: {} }, 1, session.asSession);
    expect([first.operationId, second.operationId]).toEqual([OP, OP]);
  });
});
