import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';

const parsePort = (value: string | undefined): number => {
  const parsed = Number(value ?? '3000');
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return parsed;
};

const bootstrap = async (): Promise<void> => {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.enableShutdownHooks();

  const host = process.env['HOST'] ?? '127.0.0.1';
  const port = parsePort(process.env['PORT']);
  await app.listen(port, host);
  Logger.log(`API listening on ${host}:${String(port)}`, 'Bootstrap');
};

await bootstrap();
