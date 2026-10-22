import { Types } from 'mongoose';
import { MigrationsRepository } from '../../../src/migrations/migrations.repository';

describe('MigrationsRepository.create', () => {
  const repoWith = (create: jest.Mock) => new MigrationsRepository({ create } as never);

  it('inserts a pending cutover with a fresh operationId', async () => {
    const create = jest.fn(async () => undefined);

    const doc = await repoWith(create).create('t1', 'key-1', 'owner-1');

    expect(doc).toMatchObject({ tenantId: 't1', idempotencyKey: 'key-1', ownerId: 'owner-1', type: 'cutover', status: 'pending', attempts: 0 });
    expect(doc!._id).toBeInstanceOf(Types.ObjectId);
    expect(create).toHaveBeenCalledWith(doc);
  });

  it('returns null when a concurrent request already took the key', async () => {
    const create = jest.fn(async () => Promise.reject(Object.assign(new Error('E11000 duplicate key'), { code: 11000 })));

    await expect(repoWith(create).create('t1', 'key-1', 'owner-1')).resolves.toBeNull();
  });

  it('passes any other write error on', async () => {
    const create = jest.fn(async () => Promise.reject(new Error('not primary')));

    await expect(repoWith(create).create('t1', 'key-1', 'owner-1')).rejects.toThrow('not primary');
  });
});
