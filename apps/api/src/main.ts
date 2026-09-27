import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { AppConfig } from './config/config';

async function main() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureApp(app);
  const config = app.get(AppConfig);
  await app.listen(config.port, '0.0.0.0');
  console.log(`NeerNow API listening on port ${config.port} (${config.nodeEnv}, SMS: ${config.smsProvider})`);
}

main().catch((err) => {
  console.error(`API failed to start: ${err.message}`);
  process.exit(1);
});
