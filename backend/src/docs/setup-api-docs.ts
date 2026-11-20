import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import type { Express, Request, Response } from 'express';

import { AppConfigService } from '../config/config.module';
import { buildOpenApiDocument } from '../contract/openapi-document';

/**
 * Fiação da documentação de referência (issue #23), extraída do `bootstrap()`
 * para ser testável sem subir servidor (M1).
 *
 * Três decisões que não são acidentais:
 *
 * - o documento vem do seam `buildOpenApiDocument()`: `/docs` não descreve um
 *   contrato diferente do `openapi.yaml`; é o mesmo objeto que `openapi:generate`
 *   escreve;
 * - a UI e o bundle vivem **só fora de produção** (guarda na primeira linha): o
 *   pacote é devDependency e não existe na imagem;
 * - o bundle da UI é **auto-hospedado** (`/docs/scalar.js`), não vem de CDN. A
 *   máquina de desenvolvimento não tem rede (`AGENTS.md`), e um `/docs` que
 *   responde 200 e fica em branco offline é pior que um `/docs` que não existe.
 */
export const API_DOCS_PATH = '/docs';
/** O mesmo documento que a UI renderiza, em JSON. */
export const API_DOCS_JSON_PATH = '/docs-json';
/** Rota do bundle UMD auto-hospedado; é o `cdn` passado ao Scalar. */
export const API_DOCS_BUNDLE_PATH = '/docs/scalar.js';

/**
 * Caminho absoluto do build UMD de arquivo único, dentro do `node_modules`.
 *
 * `require.resolve('@scalar/api-reference/dist/browser/standalone.js')` não
 * serve: o mapa de `exports` do pacote não expõe `dist/browser/*`
 * (`ERR_PACKAGE_PATH_NOT_EXPORTED`). Resolver a entrada do pacote e descer para
 * o irmão `browser/` funciona, e o `resolve` já segue o symlink do pnpm.
 *
 * Chamada **depois** da guarda de produção, nunca no topo do módulo: em produção
 * o pacote não está instalado e o boot quebraria aqui.
 */
export function scalarBundlePath(): string {
  const packageEntry = require.resolve('@scalar/api-reference');
  const bundle = join(dirname(packageEntry), 'browser', 'standalone.js');

  if (!existsSync(bundle)) {
    // Falha alto: um `/docs` em branco no navegador é o defeito que esta rota
    // existe para não ter, e o erro nomeia o caminho que faltou.
    throw new Error(
      `@scalar/api-reference: UMD bundle not found at ${bundle}. ` +
        'The version is pinned in devDependencies — run `pnpm --dir backend install`.',
    );
  }

  return bundle;
}

/**
 * Monta `/docs` (Scalar) e `/docs-json` sobre o documento do seam.
 *
 * Não faz nada em produção — a guarda é a primeira linha.
 */
export async function setupApiDocs(app: INestApplication): Promise<void> {
  if (app.get(AppConfigService).isProd) {
    return;
  }

  const document = await buildOpenApiDocument();
  const express = app.getHttpAdapter().getInstance() as Express;
  // Resolvido aqui, dentro do bloco de dev: o `require.resolve` do pacote não
  // pode acontecer no topo do módulo (em produção o pacote não existe) e a falha
  // alta é no boot, não num 500 por requisição.
  const bundlePath = scalarBundlePath();

  // O bundle local no lugar do jsDelivr: é isto que faz `/docs` renderizar
  // offline. A rota é registrada antes de `app.use('/docs', …)`, senão o
  // middleware da UI responderia o HTML em `/docs/scalar.js`.
  express.get(API_DOCS_BUNDLE_PATH, (_request: Request, response: Response): void => {
    // Buffer, e não `res.sendFile`: com caminho absoluto o `sendFile` do Express 5
    // responde 500 nesta rota (medido), e o HTML apontaria para um bundle que não
    // sai. 5 MB por requisição é aceitável em dev; o `type` explícito mantém
    // `text/javascript`, que é o que um cliente só-texto (supertest) decodifica.
    response
      .type('text/javascript')
      .set('Cache-Control', 'no-store')
      .send(readFileSync(bundlePath));
  });

  // A UI consome este JSON; um cliente em dev descobre o contrato aqui.
  express.get(API_DOCS_JSON_PATH, (_request: Request, response: Response): void => {
    response.json(document);
  });

  // `await import` e não `require`: `@scalar/client-side-rendering` é ESM-only e
  // o `require` interno do Jest quebra nele ("Unexpected token 'export'"), mesmo
  // via `createRequire`. O import dinâmico mantém o pacote fora do caminho de
  // produção (nunca alcançado por causa da guarda) e fora de
  // `buildOpenApiDocument()`.
  const { apiReference } = await import('@scalar/nestjs-api-reference');

  // Passar `cdn` troca o build ESM (que buscaria os chunks no jsDelivr) pelo UMD
  // de arquivo único: o HTML sai com `<script src="/docs/scalar.js">` e
  // `Scalar.createApiReference`, sem uma única requisição externa.
  app.use(API_DOCS_PATH, apiReference({ content: document, cdn: API_DOCS_BUNDLE_PATH }));
}
