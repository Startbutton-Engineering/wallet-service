import { Global, Module } from "@nestjs/common";
import { CONFIG, loadConfig } from "./index";

@Global()
@Module({
  providers: [{ provide: CONFIG, useFactory: () => loadConfig() }],
  exports: [CONFIG]
})
export class ConfigModule {}
