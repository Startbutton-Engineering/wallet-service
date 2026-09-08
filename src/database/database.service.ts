import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ClientSession, Collection, Db, Document, MongoClient } from "mongodb";
import type { AppConfig } from "../config";
import { CONFIG } from "../config";

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private client!: MongoClient;
  private database!: Db;

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  async onModuleInit(): Promise<void> {
    await this.connect()
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.close();
  }

  async connect(): Promise<void> {
    if (this.client) return
    this.client = new MongoClient(this.config.mongoUri);
    await this.client.connect();
    this.database = this.client.db(this.config.dbName);
  }

  get db(): Db {
    return this.database;
  }

  collection<T extends Document = Document>(name: string): Collection<T> {
    return this.database.collection<T>(name)
  }

  startSession(): ClientSession {
    return this.client.startSession();
  }

  async ping(): Promise<boolean> {
    const res = await this.database.command({ ping: 1 });
    return res.ok === 1;
  }
}