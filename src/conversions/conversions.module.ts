import { Module } from "@nestjs/common";
import { ConversionsController } from "./conversions.controller";
import { ConversionsService } from "./conversions.service";

@Module({
  controllers: [ConversionsController],
  providers: [ConversionsService],
  exports: [ConversionsService]
})
export class ConversionsModule {}
