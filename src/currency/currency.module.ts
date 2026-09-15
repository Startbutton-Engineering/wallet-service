import { Global, Module } from "@nestjs/common";
import { CurrencyController } from "./currency.controller";
import { CurrencyRegistryService } from "./currency-registry.service";

@Global()
@Module({
  controllers: [CurrencyController],
  providers: [CurrencyRegistryService],
  exports: [CurrencyRegistryService]
})
export class CurrencyModule {}