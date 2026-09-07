import 'dotenv/config';
import 'reflect-metadata'
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './config';
import { AppExceptionsFilter } from './common/error.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  app.useGlobalFilters(new AppExceptionsFilter())
  const config = loadConfig()
  await app.listen(config.httpPort || 3000, () => {
    console.log(`Server is running on port ${config.httpPort || 3000}`);
  });
}
bootstrap();
