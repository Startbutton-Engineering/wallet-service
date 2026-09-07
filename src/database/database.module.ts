import { Global, Module } from "@nestjs/common";
import { CONFIG, loadConfig } from "../config";
import { DatabaseService } from "./database.service";

@Global()
@Module({
  providers: [
    { provide: CONFIG, useFactory: () => loadConfig() },
    DatabaseService
  ],
  exports: [DatabaseService, CONFIG]
})
export class DatabaseModule {}