import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { CutoverService } from "./cutover.service";
import { MigrationsController } from "./migrations.controller";
import { CutoverConsumer } from "./cutover.consumer";
import { MigrationsRepository } from "./migrations.repository";
import { Migration, MigrationSchema } from "./migration.schema";

@Module({
  imports: [MongooseModule.forFeature([{ name: Migration.name, schema: MigrationSchema }])],
  controllers: [MigrationsController],
  providers: [CutoverService, MigrationsRepository, CutoverConsumer],
})
export class MigrationsModule {}
