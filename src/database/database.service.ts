import { Injectable } from "@nestjs/common";
import { InjectConnection } from "@nestjs/mongoose";
import { ClientSession, Connection, mongo } from "mongoose";

@Injectable()
export class DatabaseService {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  get db(): mongo.Db {
    const db = this.connection.db;
    if (!db) throw new Error('Mongoose connection is not established yet');
    return db;
  }

  get conn(): Connection {
    return this.connection;
  }

  collection<T extends mongo.Document = mongo.Document>(name: string): mongo.Collection<T> {
    return this.db.collection<T>(name);
  }

  startSession(): Promise<ClientSession> {
    return this.connection.startSession();
  }

  async ping(): Promise<boolean> {
    const res = await this.db.command({ ping: 1 });
    return res.ok === 1;
  }
}
