import { Module } from "@nestjs/common";
import { WalletsService } from "./wallets.service";
import { WalletsController } from "./wallets.controller";
import { StatementService } from "./statement.service";

@Module({
  controllers: [WalletsController],
  providers: [WalletsService, StatementService],
  exports: [WalletsService]
})
export class WalletsModule {}