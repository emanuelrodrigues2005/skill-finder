import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '@/app.module';
import { setupApiDocs } from '@/docs/setup-api-docs';
import { configureApp } from '@/main';
import { PrismaService } from '@/prisma/prisma.service';

/**
 * Fiação de `/docs` e `/docs-json` (issue #23, achado M1 da revisão).
 *
 * O `bootstrap()` monta a UI de referência sobre o seam `buildOpenApiDocument()`,
 * e até aqui nada passava por essa fiação: um `apiReference` com opção errada, um
 * path trocado ou a guarda de produção quebrada ficavam invisíveis. Este arquivo
 * sobe a app de runtime (`AppModule`) e chama `setupApiDocs()` na **mesma ordem do
 * `bootstrap()`** (`configureApp` → docs → `init`), senão a ordem de registro no
 * Express mudaria e o teste provaria outra coisa: rota crua registrada depois do
 * `init` cai no handler de 404 do Nest (verificado antes de escrever este arquivo).
 *
 * Os caminhos e a lista de paths são **literais**, não constantes importadas de
 * `setup-api-docs.ts`: importar `API_DOCS_PATH` faria o teste concordar com
 * qualquer valor que a fiação passasse a usar, e o contrato de a UI estar em
 * `/docs` deixaria de ser verificado.
 *
 * Sem socket para o Postgres: `setupApiDocs()` chama `buildOpenApiDocument()`, que
 * cria uma app efêmera própria com o `NestFactory` — não há `overrideProvider` para
 * alcançá-la. Por isso o `jest.mock` abaixo (mesmo recurso de
 * `openapi-document.spec.ts`) tira o `onModuleInit` do Prisma real do caminho, e o
 * `overrideProvider` do `AppModule` mantém o dublê explícito na app testada. O
 * `nock.disableNetConnect()` do `test/setup.ts` continua valendo.
 *
 * **Pré-requisito de execução** (descoberto rodando este arquivo, evidências no
 * relatório da revisão): `@scalar/nestjs-api-reference` depende de
 * `@scalar/client-side-rendering`, que é ESM-only. Sob o runtime CJS do Jest isso
 * só carrega por `await import(...)` nativo da fiação — `require` /
 * `createRequire` falham com "Must use import to load ES Module" —, e o `import()`
 * precisa chegar intacto ao runtime: `NODE_OPTIONS=--experimental-vm-modules` no
 * `test:e2e` e `isolatedModules: true` no ts-jest de `test/jest-e2e.json`. Sem o
 * `isolatedModules`, o ts-jest baixa o `import()` para `require()` e a fiação fica
 * impossível de testar sem dublar a UI — o que tornaria os casos 1 e 2 vacuidade.
 */
jest.mock('@/prisma/prisma.service', () => ({
  PrismaService: class PrismaStub {
    ping(): Promise<boolean> {
      return Promise.resolve(true);
    }
  },
}));

/** As dez rotas do contrato v0 — mesma lista de `openapi-contract.spec.ts`. */
const EXPECTED_PATHS = [
  '/api/v1/admin/ingest',
  '/api/v1/admin/ingest/runs',
  '/api/v1/categories',
  '/api/v1/search',
  '/api/v1/searches/{request_id}',
  '/api/v1/skills',
  '/api/v1/skills/{skill_id}',
  '/healthz',
  '/metrics',
  '/readyz',
] as const;

/**
 * Variáveis exigidas por `ENV=prod` em `config/env.schema.ts` (`DATABASE_URL`,
 * `IP_HASH_SALT`, `ADMIN_TOKEN` e `LLM_ENABLED=false` para dispensar
 * `LLM_API_KEY`). Senha explícita que **não** é a default de dev (`skillsdev`),
 * que o schema recusa.
 */
const PROD_ENV = {
  ENV: 'prod',
  DATABASE_URL: 'postgresql://skills:prod-only-password@127.0.0.1:5432/skills',
  IP_HASH_SALT: 'prod-test-salt',
  ADMIN_TOKEN: 'prod-test-admin-token-com-32-chars-ok',
  LLM_ENABLED: 'false',
} as const;

const RESTORED_ENV_KEYS = [
  'ENV',
  'DATABASE_URL',
  'IP_HASH_SALT',
  'ADMIN_TOKEN',
  'LLM_ENABLED',
] as const;

/**
 * Subir o `AppModule` no ts-jest custa caro na primeira vez (o grafo inteiro
 * passa pelo compilador). O default de 5 s do Jest transformaria "lento" em
 * "quebrado".
 */
const STARTUP_TIMEOUT_MS = 120_000;

class PrismaStub {
  ping(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

/** Espelha o começo do `bootstrap()`: `Test.createTestingModule` + `configureApp`. */
async function createRuntimeApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(new PrismaStub())
    .compile();

  const app = moduleRef.createNestApplication();
  configureApp(app);
  return app;
}

describe('api docs wiring (e2e)', () => {
  let app: INestApplication;
  let prodApp: INestApplication | undefined;

  /** Snapshot do ambiente do `test/setup.ts` — restaurado no `afterAll`. */
  const savedEnv = new Map<string, string | undefined>(
    RESTORED_ENV_KEYS.map((key) => [key, process.env[key]]),
  );

  function restoreEnv(): void {
    for (const [key, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  beforeAll(async () => {
    app = await createRuntimeApp();
    // Antes do `init()`, como no `bootstrap()`: `setupApiDocs` registra rotas
    // direto no Express, e o Nest só aplica as do router no `init`.
    await setupApiDocs(app);
    await app.init();
  }, STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    restoreEnv();
    await prodApp?.close();
    await app.close();
  });

  it('serves the Scalar UI at /docs', async () => {
    const response = await request(app.getHttpServer()).get('/docs').expect(200);

    expect(response.headers['content-type']).toContain('text/html');
    // Não asserta a marca do CDN (já é o caso 2) nem o título: o que importa é
    // que o HTML é a UI e não, por exemplo, o envelope JSON de erro.
    expect(response.text.toLowerCase()).toContain('scalar');
  });

  it('serves the bundle locally, not from a CDN', async () => {
    const page = await request(app.getHttpServer()).get('/docs').expect(200);

    // H1 da revisão: o CDN é o valor **default** de `apiReference` (o build ESM
    // em `cdn.jsdelivr.net`). Se alguém remover a opção `cdn` que aponta para o
    // bundle local, a página volta a depender da rede e este caso fica vermelho
    // — a máquina de desenvolvimento não tem rede (AGENTS.md).
    expect(page.text).not.toContain('cdn.jsdelivr.net');
    expect(page.text).toContain('/docs/scalar.js');

    // Um HTML apontando para `/docs/scalar.js` que responde 404 seria um `/docs`
    // em branco: o bundle tem que sair de verdade, com JS e tamanho de bundle.
    const bundle = await request(app.getHttpServer()).get('/docs/scalar.js').expect(200);
    expect(bundle.headers['content-type']).toMatch(/javascript/);
    expect(bundle.text.length).toBeGreaterThan(100_000);
  });

  it('serves the ten contract paths at /docs-json', async () => {
    const response = await request(app.getHttpServer()).get('/docs-json').expect(200);

    expect(response.headers['content-type']).toContain('application/json');
    const paths = Object.keys(response.body.paths as Record<string, unknown>).sort();
    expect(paths).toEqual([...EXPECTED_PATHS]);
    expect(paths).toHaveLength(10);
  });

  it('documents the admin ingest body, so the route is usable from /docs (#49)', async () => {
    // Criterion da #49: a rota de execução da ingestão aparece em `/docs` — a UI
    // lê este mesmo `/docs-json`. Até a #49 o POST era contract-only e sem corpo
    // documentado; sem o `requestBody`, a UI não teria como mostrar as chaves do
    // refresh sob demanda (e o `x-internal` continua marcando a superfície).
    const response = await request(app.getHttpServer()).get('/docs-json').expect(200);

    const operation = response.body.paths['/api/v1/admin/ingest'].post;
    expect(operation['x-internal']).toBe(true);
    expect(operation.requestBody.content['application/json'].schema.$ref).toBe(
      '#/components/schemas/IngestRequest',
    );
    expect(operation.responses['202'].content['application/json'].schema.$ref).toBe(
      '#/components/schemas/IngestOutcomeResponse',
    );
    // Os dois erros de borda da rota estão no documento.
    expect(Object.keys(operation.responses).sort()).toEqual(
      expect.arrayContaining(['202', '401', '409', '422', '500']),
    );
  });

  it('keeps /docs out of production', async () => {
    Object.assign(process.env, PROD_ENV);
    try {
      prodApp = await createRuntimeApp();

      // A guarda é a primeira linha: resolve sem tocar no documento nem registrar
      // rota. Se o `buildOpenApiDocument()` passasse a rodar antes da guarda, o
      // caso continuaria verde nos 404 abaixo — por isso o `.resolves` aqui.
      await expect(setupApiDocs(prodApp)).resolves.toBeUndefined();
      await prodApp.init();

      for (const path of ['/docs', '/docs-json', '/docs/scalar.js']) {
        const response = await request(prodApp.getHttpServer()).get(path).expect(404);
        // 404 do router (envelope de §5.5), não um 404/500 de acidente.
        expect({ path, code: response.body.error.code }).toEqual({ path, code: 'NOT_FOUND' });
      }
    } finally {
      restoreEnv();
    }
  }, STARTUP_TIMEOUT_MS);

  it('does not mount the contract routes in the runtime', async () => {
    // D0: o contrato v0 documenta rotas que o runtime ainda não serve. Montar o
    // contrato no `AppModule` para "fazer /docs ficar certo" responderia um 500
    // do `contractOnly` em vez de 404 — aqui é a suíte que passa por
    // `setupApiDocs`, então um vazamento do grafo do documento para o runtime
    // aparece neste caso.
    const response = await request(app.getHttpServer()).get('/api/v1/search').expect(404);

    expect(response.body.error.code).toBe('NOT_FOUND');
  });
});
