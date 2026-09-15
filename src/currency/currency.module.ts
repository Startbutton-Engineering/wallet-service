import { Global, Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { CurrencyController } from "./currency.controller";
import { CurrencyRegistryService } from "./currency-registry.service";
import { CurrencyModel, CurrencySchema } from "./currency.schema";

@Global()
@Module({
  imports: [MongooseModule.forFeature([{ name: CurrencyModel.name, schema: CurrencySchema }])],
  controllers: [CurrencyController],
  providers: [CurrencyRegistryService],
  exports: [CurrencyRegistryService, MongooseModule]
})
export class CurrencyModule {}