import { Injectable, OnModuleInit } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { Currency, CurrencyType, DEFAULT_CURRENCIES } from "./currency";
import { CurrencyModel } from "./currency.schema";
import { AppError } from "../common/errors";

@Injectable()
export class CurrencyRegistryService implements OnModuleInit {
  constructor(@InjectModel(CurrencyModel.name) private readonly model: Model<Currency>) {}

  async onModuleInit(): Promise<void> {
    await this.model.createCollection().catch(() => undefined);
    await this.model.syncIndexes().catch(() => undefined);
    const count = await this.model.estimatedDocumentCount();
    if (count === 0) {
      await this.model.insertMany(DEFAULT_CURRENCIES.map((curr) => ({ ...curr })))
    }
  }

  async register(input: { code: string; scale: number; type: CurrencyType }): Promise<Currency> {
    const currency: Currency = { code: input.code, scale: input.scale, type: input.type };
    await this.model.updateOne({ code: currency.code }, { $set: currency }, { upsert: true });
    return currency;
  }

  async list(): Promise<Currency[]> {
    return this.model.find().select('-_id').sort({ code: 1 }).lean<Currency[]>().exec();
  }

  async get(code: string): Promise<Currency | null> {
    return this.model.findOne({ code }).select('-_id').lean<Currency>().exec();
  }

  async require(code: string): Promise<Currency> {
    const currency = await this.get(code);
    if (!currency) throw AppError.invalidCurrency(code);
    return currency;
  }
}