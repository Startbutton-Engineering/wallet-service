import { Module } from "@nestjs/common";
import { TopupsController } from "./topups.controller";
import { TopupsService } from "./topups.service";

@Module({
  controllers: [TopupsController],
  providers: [TopupsService],
  exports: [TopupsService]
})
export class TopupsModule {}
