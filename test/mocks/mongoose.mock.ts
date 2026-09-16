import { ClientSession, Model } from 'mongoose';
import { mongo } from 'mongoose';

/** A chainable stand-in for a mongoose Query.
 * `lean()`, `select()` and `sort()` return the query itself, exactly as mongoose does,
 * so repositories can chain them in any order; `exec()` resolves the canned result. */
export interface MockQuery<T> {
  lean: jest.Mock<MockQuery<T>, []>;
  select: jest.Mock<MockQuery<T>, [unknown?]>;
  sort: jest.Mock<MockQuery<T>, [unknown?]>;
  exec: jest.Mock<Promise<T>, []>;
}

export function mockQuery<T>(result: T): MockQuery<T> {
  const query = {} as MockQuery<T>;
  query.lean = jest.fn(() => query);
  query.select = jest.fn(() => query);
  query.sort = jest.fn(() => query);
  query.exec = jest.fn(async () => result);
  return query;
}

export interface MockSession {
  withTransaction: jest.Mock;
  abortTransaction: jest.Mock;
  endSession: jest.Mock;
  /** Handed to the real ClientSession-typed parameters the repositories take. */
  asSession: ClientSession;
}

/** A session whose `withTransaction` simply runs the callback — enough for the
 * transactional repositories, which only ever pass the session through to mongoose. */
export function mockSession(): MockSession {
  const session = {
    withTransaction: jest.fn(async (fn: () => Promise<unknown>) => fn()),
    abortTransaction: jest.fn(async () => undefined),
    endSession: jest.fn(async () => undefined),
  } as unknown as MockSession;
  session.asSession = session as unknown as ClientSession;
  return session;
}

export interface MockModel<T = any> {
  find: jest.Mock;
  findOne: jest.Mock;
  updateOne: jest.Mock;
  create: jest.Mock;
  insertMany: jest.Mock;
  bulkWrite: jest.Mock;
  exists: jest.Mock;
  createCollection: jest.Mock;
  syncIndexes: jest.Mock;
  estimatedDocumentCount: jest.Mock;
  db: { startSession: jest.Mock };
  /** The same object, typed as the mongoose Model the constructors expect. */
  asModel: Model<T>;
}

/** A mongoose Model stand-in. Every method is a jest.fn with a sane default
 * (empty result sets, successful writes) so a test only overrides what it cares about. */
export function mockModel<T = any>(session: MockSession = mockSession()): MockModel<T> {
  const model = {
    find: jest.fn(() => mockQuery([] as unknown[])),
    findOne: jest.fn(() => mockQuery(null)),
    updateOne: jest.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
    create: jest.fn(async (docs: unknown) => docs),
    insertMany: jest.fn(async (docs: unknown) => docs),
    bulkWrite: jest.fn(async () => ({ ok: 1 })),
    exists: jest.fn(async () => null),
    createCollection: jest.fn(async () => undefined),
    syncIndexes: jest.fn(async () => undefined),
    estimatedDocumentCount: jest.fn(async () => 0),
    db: { startSession: jest.fn(async () => session) },
  } as unknown as MockModel<T>;
  model.asModel = model as unknown as Model<T>;
  return model;
}

/** A MongoServerError carrying the error labels / codes LedgerService branches on. */
export function mongoServerError(
  options: { code?: number; codeName?: string; labels?: string[] } = {},
): mongo.MongoServerError {
  const err = new mongo.MongoServerError({ message: 'mock mongo error' });
  if (options.code !== undefined) err.code = options.code;
  if (options.codeName !== undefined) err.codeName = options.codeName;
  const labels = options.labels ?? [];
  err.hasErrorLabel = (label: string) => labels.includes(label);
  return err;
}
