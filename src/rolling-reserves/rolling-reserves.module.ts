import { Module } from "@nestjs/common";
import { RollingReservesController } from "./rolling-reserves.controller";
import { RollingReservesService } from "./rolling-reserves.service";

@Module({
  controllers: [RollingReservesController],
  providers: [RollingReservesService],
  exports: [RollingReservesService]
})
export class RollingReservesModule {}
