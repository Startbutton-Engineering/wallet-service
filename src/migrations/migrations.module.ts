import { Module } from "@nestjs/common";
import { CutoverService } from "./cutover.service";
import { MigrationsController } from "./migrations.controller";

@Module({
  controllers: [MigrationsController],
  providers: [CutoverService],
})
export class MigrationsModule {}
