import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { stringify } from 'yaml';

import { OpenApiDocumentModule } from '../src/contract/openapi-document.module';
import { applyGlobalPrefix, openApiOptions } from '../src/main';

/**
 * Escreve `openapi.yaml` na raiz do monorepo (F2.1 é o dono do arquivo; este
 * script mantém o artefato em sincronia com os controllers).
 *
 * A app nasce de `OpenApiDocumentModule`, não de `AppModule`: o contrato v0
 * documenta sete rotas que o runtime ainda não monta, e o documento é a única
 * coisa que precisa enxergá-las. O artefato sai exatamente de
 * `createDocument(app, openApiOptions())` — sem pós-processamento.
 *
 * Rodado com `ts-node`, então `__dirname` é `backend/scripts`.
 */
async function main(): Promise<void> {
  const app = await NestFactory.create(OpenApiDocumentModule, { logger: false });
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
