import { Controller, Get } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { Public } from "../auth/public.decorator";

@Controller('health')
export class HealthController {
  constructor(private readonly databaseService: DatabaseService) {}

  @Public()
  @Get()
  async health(): Promise<{ status: string; database: { connected: boolean; replicaSet: boolean } }> {
    const db = this.databaseService.db;
    const isConnected = await db.command({ ping: 1 }).then(() => true).catch(() => false);
    const isReplicaSet = await db.command({ isMaster: 1 }).then((result) => !!result.setName).catch(() => false);

    return {
      status: 'ok',
      database: {
        connected: isConnected,
        replicaSet: isReplicaSet
      }
    };
  }
}