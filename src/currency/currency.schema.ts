import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import type { CurrencyType } from "./currency";

@Schema({ collection: 'currencies', versionKey: false })
export class CurrencyModel {
  @Prop({ type: String, unique: true })
  code: string;

  @Prop({ type: Number })
  scale: number;

  @Prop({ type: String })
  type: CurrencyType;
}

export const CurrencySchema = SchemaFactory.createForClass(CurrencyModel);
