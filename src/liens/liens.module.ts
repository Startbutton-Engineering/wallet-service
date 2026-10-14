import { Module } from "@nestjs/common";
import { LiensController } from "./liens.controller";
import { LiensService } from "./liens.service";

@Module({
  controllers: [LiensController],
  providers: [LiensService],
  exports: [LiensService]
})
export class LiensModule {}
