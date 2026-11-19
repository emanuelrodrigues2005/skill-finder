/**
 * Issue #49 — `POST /api/v1/admin/ingest` e `GET /api/v1/admin/ingest/runs`
 * **no runtime**.
 *
 * Até aqui as duas rotas existiam só no contrato (`contract-admin.controller.ts`,
 * importado apenas pelo gerador do OpenAPI) e o `AppModule` respondia 404. Estes
 * casos sobem o grafo de runtime como `health.e2e-spec.ts` e trocam **só as
 * portas** (`CATALOG_SOURCE`, `CATALOG_REPOSITORY`, `INGEST_RUN_LOG` e
 * `PrismaService`) por dublês — nenhum socket é aberto e o
 * `nock.disableNetConnect()` do `test/setup.ts` continua valendo.
 *
 * O que fica provado sobre HTTP:
 * 1. sem `X-Admin-Token`, ou com token errado, a resposta é `401` no envelope
 *    único de §5.5 — e o token recebido **não** aparece no corpo;
 * 2. corpo com 21 chaves (ou sem `source_keys`) é `422 VALIDATION_ERROR`;
 * 3. `202` com o **resultado do run** (`items_requested`/`seen`/`upserted`/
 *    `deactivated`, `error_code`, janela de tempo) para até 20 chaves — o
 *    `items_seen` aqui é o tamanho do pedido, nunca o total de skills;
 * 4. duas execuções simultâneas não rodam juntas: a segunda recebe `409` e a
 *    fonte é chamada uma vez só (o rate limit do skills.sh não dobra);
 * 5. `GET /admin/ingest/runs` devolve a página do `ingest_run` (§5.6).
 */
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { INGEST_RUN_LOG } from '@/admin/admin.tokens';
import { AppModule } from '@/app.module';
import { CATALOG_ADAPTER, CATALOG_REPOSITORY, CATALOG_SOURCE } from '@/catalog/catalog.module';
import type {
  CatalogRepository,
  IngestRunFinish,
  IngestRunLog,
  IngestRunRow,
  RotationBands,
} from '@/catalog/catalog-repository';
import type { SkillRecord, SkillSource } from '@/catalog/skill-source';
import { configureApp } from '@/main';
import { PrismaService } from '@/prisma/prisma.service';

// Configuração fixa do arquivo: um `.env` local não pode mudar o cenário. O
// `test/setup.ts` já define um token; aqui o valor é explícito para o caso de
// token errado ter um alvo claro.
const ADMIN_TOKEN = 'test-admin-token-issue-49-com-32-chars';
process.env.ADMIN_TOKEN = ADMIN_TOKEN;

const PATH = '/api/v1/admin/ingest';
const RUNS_PATH = '/api/v1/admin/ingest/runs';
const REQUEST_ID = /^req_[0-9A-Z]{26}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** Dublê do banco: as rotas de admin nunca chegam no Prisma real. */
class PrismaStub {
  ping(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

function record(sourceKey: string): SkillRecord {
  return {
    source_key: sourceKey,
    source_url: `https://skills.sh/${sourceKey}`,
    name: sourceKey.split('/')[2] ?? sourceKey,
    summary: 'summary',
    category_slug: 'backend',
    stars: 10,
    installs: 20,
    vulnerability_count: null,
    security_status: 'ok',
    repo_url: null,
    skill_md_present: false,
    first_seen_at: null,
    raw: null,
  };
}

/**
 * Fonte dublê: entrega o registro de cada chave pedida (chave desconhecida é
 * omitida, como no contrato de `fetchSkills`) e sabe **segurar** uma chamada
 * para o caso de concorrência.
 */
class FakeSource implements SkillSource {
  readonly capabilities = { supports_categories: false, supports_documents: false };
  readonly fetchCalls: string[][] = [];
  listKeysCalls = 0;
  private gate: Promise<void> | null = null;
  private entered: (() => void) | null = null;

  /** Segura a próxima `fetchSkills`; `entered` resolve quando ela foi chamada. */
  queueGate(): { entered: Promise<void>; release: () => void } {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let enteredResolve: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    this.gate = gate;
    this.entered = enteredResolve;
    return {
      entered,
      release: () => {
        this.gate = null;
        open();
      },
    };
  }

  async fetchSkills(keys: readonly string[]): Promise<SkillRecord[]> {
    this.fetchCalls.push([...keys]);
    const entered = this.entered;
    this.entered = null;
    entered?.();
    const gate = this.gate;
    if (gate !== null) {
      await gate;
    }
    return keys.map(record);
  }

  listKeys(): Promise<string[]> {
    this.listKeysCalls += 1;
    return Promise.resolve(['example/repo/rotated']);
  }

  listCategories(): Promise<never[]> {
    return Promise.resolve([]);
  }

  fetchDocument(): Promise<null> {
    return Promise.resolve(null);
  }
}

/** Repositório em memória: `CatalogRepository` (escrita) + `IngestRunLog` (leitura). */
class InMemoryCatalog implements CatalogRepository, IngestRunLog {
  readonly runs: IngestRunRow[] = [];
  readonly finished: IngestRunFinish[] = [];
  stored: SkillRecord[] = [];

  failStaleRuns(): Promise<number> {
    return Promise.resolve(0);
  }

  startRun(run: {
    adapter: string;
    started_at: Date;
    items_requested?: number | null;
  }): Promise<number> {
    const id = this.runs.length + 1;
    this.runs.push({
      id,
      adapter: run.adapter,
      started_at: run.started_at,
      finished_at: null,
      status: 'running',
      items_seen: null,
      items_upserted: null,
      items_deactivated: null,
      items_requested: run.items_requested ?? null,
      error_code: null,
      error_detail: null,
    });
    return Promise.resolve(id);
  }

  finishRun(id: number, patch: IngestRunFinish): Promise<void> {
    const index = this.runs.findIndex((candidate) => candidate.id === id);
    if (index < 0) {
      return Promise.reject(new Error(`run ${id} não existe`));
    }
    this.finished.push(patch);
    const row = this.runs[index];
    if (row !== undefined) {
      Object.assign(row, {
        status: patch.status,
        finished_at: patch.finished_at,
        items_seen: patch.items_seen,
        items_upserted: patch.items_upserted,
        items_deactivated: patch.items_deactivated,
        error_code: patch.error_code ?? null,
        error_detail: patch.error_detail ?? null,
      });
    }
    return Promise.resolve();
  }

  countActiveSkills(): Promise<number> {
    return Promise.resolve(0);
  }

  selectRotationKeys(): Promise<RotationBands> {
    return Promise.resolve({ hot: [], cold: [] });
  }

  selectUnseenKeys(): Promise<string[]> {
    return Promise.resolve([]);
  }

  upsertSkills(skills: SkillRecord[]): Promise<number> {
    this.stored = [...skills];
    return Promise.resolve(new Set(skills.map((skill) => skill.source_key)).size);
  }

  deactivateSkillsStaleBefore(): Promise<number> {
    return Promise.resolve(0);
  }

  listRuns(limit: number, offset: number): Promise<IngestRunRow[]> {
    // Mais recente primeiro, como o `ORDER BY started_at DESC` do repositório.
    return Promise.resolve([...this.runs].reverse().slice(offset, offset + limit));
  }

  countRuns(): Promise<number> {
    return Promise.resolve(this.runs.length);
  }
}

describe('admin ingest at runtime (#49)', () => {
  let app: INestApplication;
  let source: FakeSource;
  let catalog: InMemoryCatalog;

  beforeAll(async () => {
    source = new FakeSource();
    catalog = new InMemoryCatalog();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(new PrismaStub())
      .overrideProvider(CATALOG_SOURCE)
      .useValue(source)
      .overrideProvider(CATALOG_REPOSITORY)
      .useValue(catalog)
      .overrideProvider(INGEST_RUN_LOG)
      .useValue(catalog)
      .overrideProvider(CATALOG_ADAPTER)
      .useValue('fixture')
      .compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  function post(body: unknown, token: string | null = ADMIN_TOKEN) {
    const test = request(app.getHttpServer()).post(PATH);
    if (token !== null) {
      test.set('X-Admin-Token', token);
    }
    return test.send(body as object);
  }

  describe('proteção por token', () => {
    it('answers 401 without X-Admin-Token on both routes', async () => {
      const missing = await request(app.getHttpServer())
        .post(PATH)
        .send({ source_keys: ['a/b/one'] })
        .expect(401);

      expect(missing.body.request_id).toMatch(REQUEST_ID);
      expect(missing.body.error.code).toBe('UNAUTHORIZED');
      expect(missing.body.error.message).toBe('Missing or invalid X-Admin-Token.');

      const runs = await request(app.getHttpServer()).get(RUNS_PATH).expect(401);
      expect(runs.body.error.code).toBe('UNAUTHORIZED');
    });

    it('answers 401 for a wrong token and never echoes it', async () => {
      const wrong = 'this-token-is-wrong-issue-49';
      const response = await post({ source_keys: ['a/b/one'] }, wrong).expect(401);

      expect(response.body.error.code).toBe('UNAUTHORIZED');
      expect(JSON.stringify(response.body)).not.toContain(wrong);
      // Token errado não chega na fonte nem cria run.
      expect(catalog.runs).toHaveLength(0);
      expect(source.fetchCalls).toEqual([]);
    });
  });

  describe('validação do corpo', () => {
    it('answers 422 for 21 keys, in the single error envelope', async () => {
      const keys = Array.from({ length: 21 }, (_, index) => `owner/repo/skill-${index}`);

      const response = await post({ source_keys: keys }).expect(422);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.details.fields).toEqual(['source_keys']);
      expect(source.fetchCalls).toEqual([]);
    });

    it('answers 422 when source_keys is missing or not an array of strings', async () => {
      const missing = await post({}).expect(422);
      expect(missing.body.error.details.fields).toEqual(['source_keys']);

      const wrongType = await post({ source_keys: [42] }).expect(422);
      expect(wrongType.body.error.details.fields).toContain('source_keys');
    });
  });

  describe('execução sob demanda', () => {
    it('answers 202 with the run outcome for at most 20 keys', async () => {
      const keys = ['example/repo/one', 'example/repo/two'];
      const before = catalog.runs.length;

      const response = await post({ source_keys: keys }).expect(202);

      // O corpo é o `IngestRunOutcome`: itens pedidos/vistos/gravados, janela.
      // `items_seen` é o tamanho do pedido, nunca o total do catálogo.
      expect(response.body).toMatchObject({
        status: 'ok',
        items_requested: 2,
        items_seen: 2,
        items_upserted: 2,
        items_deactivated: 0,
        error_code: null,
        error_detail: null,
      });
      expect(response.body.request_id).toMatch(REQUEST_ID);
      expect(response.body.started_at).toMatch(RFC3339);
      expect(response.body.finished_at).toMatch(RFC3339);
      // A fonte recebeu exatamente o pedido e o run foi gravado.
      expect(source.fetchCalls.at(-1)).toEqual(keys);
      expect(catalog.runs).toHaveLength(before + 1);
      expect(catalog.runs.at(-1)?.status).toBe('ok');
      expect(catalog.runs.at(-1)?.items_requested).toBe(2);
    });

    it('answers 409 while another run is in progress, without doubling the source calls', async () => {
      // A fonte é cumulativa entre os casos: o que este caso mede é o que foi
      // chamado **depois** daqui.
      const before = source.fetchCalls.length;
      const gate = source.queueGate();
      const inFlight = post({ source_keys: ['example/repo/one'] })
        .expect(202)
        .then((response) => response);

      await gate.entered;

      // Primeiro os requests: a asserção vem depois, com tudo drenado. Assim um
      // status errado falha o teste sem deixar request preso no gate — request
      // em voo deixa a app aberta e o Jest não sai.
      let conflict: Awaited<typeof inFlight>;
      try {
        // Sem `.expect(409)`: a resposta é julgada adiante.
        conflict = await post({ source_keys: ['example/repo/two'] });
      } finally {
        gate.release();
      }
      const accepted = await inFlight;

      expect(conflict.status).toBe(409);
      expect(conflict.body.error.code).toBe('CONFLICT');
      expect(conflict.body.error.message).toBe('An ingestion run is already in progress.');
      // A fonte foi chamada uma vez só: o rodízio não dobrou o rate limit.
      expect(source.fetchCalls.slice(before)).toEqual([['example/repo/one']]);
      expect(accepted.status).toBe(202);
      expect(accepted.body.status).toBe('ok');

      // Trava liberada: a próxima execução volta a ser aceita.
      const again = await post({ source_keys: ['example/repo/two'] }).expect(202);
      expect(again.body.status).toBe('ok');
    });
  });

  describe('GET /admin/ingest/runs', () => {
    it('lists the runs, most recent first, with §5.6 pagination', async () => {
      const response = await request(app.getHttpServer())
        .get(RUNS_PATH)
        .set('X-Admin-Token', ADMIN_TOKEN)
        .expect(200);

      const latest = catalog.runs.at(-1);
      expect(response.body.request_id).toMatch(REQUEST_ID);
      expect(response.body.data.length).toBeGreaterThan(0);
      // Sem depender da ordem dos casos: a primeira linha é o run mais recente
      // que o repositório gravou.
      expect(response.body.data[0]).toMatchObject({
        run_id: String(latest?.id),
        status: latest?.status,
        skills_ingested: latest?.items_upserted,
      });
      expect(response.body.data[0].started_at).toMatch(RFC3339);
      expect(response.body.data[0].finished_at).toMatch(RFC3339);
      expect(response.body.pagination).toEqual({
        page: 1,
        page_size: 20,
        total_items: catalog.runs.length,
        total_pages: Math.ceil(catalog.runs.length / 20),
      });
    });

    it('honours page_size and rejects a page_size above the ceiling', async () => {
      const page = await request(app.getHttpServer())
        .get(`${RUNS_PATH}?page=1&page_size=1`)
        .set('X-Admin-Token', ADMIN_TOKEN)
        .expect(200);

      expect(page.body.data).toHaveLength(1);
      expect(page.body.pagination.page_size).toBe(1);
      expect(page.body.pagination.total_pages).toBe(catalog.runs.length);

      const invalid = await request(app.getHttpServer())
        .get(`${RUNS_PATH}?page_size=101`)
        .set('X-Admin-Token', ADMIN_TOKEN)
        .expect(422);
      expect(invalid.body.error.details.fields).toEqual(['page_size']);
    });
  });
});
