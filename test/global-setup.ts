import { MongoMemoryReplSet } from "mongodb-memory-server";

export default async function globalSetup(): Promise<void> {
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' }
  });
  const uri = replSet.getUri();
  process.env.TEST_MONGO_PATH = uri;
  (globalThis as unknown as { __MONGO_REPLSET__ : MongoMemoryReplSet }).__MONGO_REPLSET__ = replSet;
}