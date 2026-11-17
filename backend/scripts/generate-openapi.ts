import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { stringify } from 'yaml';

import { buildOpenApiDocument } from '../src/contract/openapi-document';

/**
 * Escreve `openapi.yaml` na raiz do monorepo (F2.1 é o dono do arquivo; este
 * script mantém o artefato em sincronia com os controllers).
 *
 * O documento vem do seam `buildOpenApiDocument()` — o mesmo que o `bootstrap()`
 * usa para o `/docs` —, então o artefato e a UI não têm como divergir. O arquivo
 * sai exatamente do documento, sem pós-processamento.
 *
 * Rodado com `ts-node`, então `__dirname` é `backend/scripts`.
 */
async function main(): Promise<void> {
  const document = await buildOpenApiDocument();
  const target = resolve(__dirname, '..', '..', 'openapi.yaml');

  await writeFile(target, stringify(document), 'utf8');
  console.log(`openapi.yaml written to ${target}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
