import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });

  const config = loadConfig()
  await app.listen(config.httpPort || 3000, () => {
    console.log(`Server is running on port ${config.httpPort || 3000}`);
  });
}
bootstrap();
