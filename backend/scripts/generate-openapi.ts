import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { stringify } from 'yaml';

import { AppModule } from '../src/app.module';
import { applyGlobalPrefix, openApiOptions } from '../src/main';

/**
 * Escreve `openapi.yaml` na raiz do monorepo (F2.1 é o dono do arquivo; este
 * script mantém o artefato em sincronia com os controllers).
 *
 * Rodado com `ts-node`, então `__dirname` é `backend/scripts`.
 */
async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  applyGlobalPrefix(app);
  await app.init();

  const document = SwaggerModule.createDocument(app, openApiOptions());
  const target = resolve(__dirname, '..', '..', 'openapi.yaml');

  await writeFile(target, stringify(document), 'utf8');
  await app.close();
  console.log(`openapi.yaml written to ${target}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
