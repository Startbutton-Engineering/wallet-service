import { Global, Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import type { AppConfig } from "../config";
import { CONFIG } from "../config";
import { ConfigModule } from "../config/config.module";
import { DatabaseService } from "./database.service";

@Global()
@Module({
  imports: [
    ConfigModule,
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [CONFIG],
      useFactory: (config: AppConfig) => ({
        uri: config.mongoUri,
        dbName: config.dbName
      })
    })
  ],
  providers: [DatabaseService],
  exports: [DatabaseService, ConfigModule, MongooseModule]
})
export class DatabaseModule {}
