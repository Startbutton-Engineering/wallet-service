import { Injectable, OnModuleInit } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { Currency, CurrencyType, DEFAULT_CURRENCIES } from "./currency";
import { AppError } from "../common/errors";

const COLLECTION = 'currencies'

@Injectable()
export class CurrencyRegistryService implements OnModuleInit {
  constructor(private readonly db: DatabaseService) {}

  private collection() {
    return this.db.collection<Currency>(COLLECTION)
  }

  async onModuleInit(): Promise<void> {
    await this.collection().createIndex({ code: 1 }, { unique: true });
    const count = await this.collection().countDocuments();
    if (count === 0) {
      await this.collection().insertMany(DEFAULT_CURRENCIES.map((curr) => ({ ...curr })))
    }
  }

  async register(input: { code: string; scale: number; type: CurrencyType }): Promise<Currency> {
    const currency: Currency = { code: input.code, scale: input.scale, type: input.type };
    await this.collection().updateOne({ code: currency.code }, { $set: currency }, { upsert: true });
    return currency;
  }

  async list(): Promise<Currency[]> {
    return this.collection().find({}, { projection: { _id: 0 } }).sort({ code: 1 }).toArray();
  }

  async get(code: string): Promise<Currency | null> {
    return this.collection().findOne({ code }, { projection: { _id: 0 } });
  }

  async require(code: string): Promise<Currency> {
    const currency = await this.get(code);
    if (!currency) throw AppError.invalidCurrency(code);
    return currency;
  }
}