/**
 * Issue #12 — nível de integração: o fluxo da busca contra **Postgres real**.
 *
 * O nível `api` (`test/api/search.e2e-spec.ts`) prova o contrato com as portas
 * trocadas por duplos. O que só o banco pode provar fica aqui:
 *
 * 1. **a ingestão é idempotente** — `UNIQUE (source_key)` mais
 *    `INSERT ... ON CONFLICT (source_key) DO UPDATE` mantém a mesma linha (mesmo
 *    `id`, mesmo `first_seen_at`) numa segunda execução. Um duplo em memória
 *    sempre passa nesse teste; o Postgres, não;
 * 2. o caminho completo `POST /api/v1/search` -> `GET /api/v1/searches/{id}` ->
 *    `GET /api/v1/skills/{id}` escreve e lê `search_request`/`skill` de verdade,
 *    e o `result_ids BIGINT[]` gravado é o mesmo conjunto que a resposta
 *    devolveu;
 * 3. a **regra 3** (dado ausente é `null`, jamais zero) vale também para a
 *    coluna: a fixture não publica `vulnerabilities` e o banco guarda `NULL`,
 *    não `0`.
 *
 * O `AppModule` sobe inteiro e sem `overrideProvider`: `SEARCH_CATALOG`,
 * `SEARCH_STORE` e `INTENT_PARSER` são os de produção, apontados para o banco
 * de teste por `setup-env.ts`. `LLM_ENABLED=false` mantém o provedor fora do
 * caminho (regra 5), então a intenção sai do fallback lexical e a resposta é
 * honestamente degradada.
 *
 * Nenhum socket externo: `127.0.0.1:55432` é o container de `make db-test-up` e
 * `assertDatabase` falha (não pula) quando ele não está no ar.
 */
import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';

import { AppModule } from '@/app.module';
import { createFixtureSource } from '@/catalog/fixture-source';
import { ingest, type IngestRunOutcome } from '@/catalog/ingest';
import { PrismaCatalogRepository } from '@/catalog/prisma-catalog.repository';
import type { SkillDetail, SkillSummary } from '@/contract/dto/catalog.dto';
import type { SearchResponse } from '@/contract/dto/search-response.dto';
import { configureApp } from '@/main';
import { sha256Hex } from '@/search/client-hash';
import { decodeSkillId } from '@/search/ids';

import { assertDatabase, createTestPrismaClient, truncateAll } from './db';
import {
  lockTestDatabase,
  serializedTestDatabaseUrl,
  unlockTestDatabase,
} from './serial';

/** 25 entradas na amostra congelada, todas com `url` e todas com chave distinta. */
const FIXTURE_SIZE = 25;

/**
 * Relógio injetado da ingestão. É **relativo** de propósito: a busca compara o
 * snapshot com `new Date()` (`SOURCE_STALE_AFTER_MS` = 6 h), então um instante
 * cravado no calendário passaria a valer `source_stale` seis horas depois de
 * escrito — o teste apodreceria sozinho. Dez minutos atrás é fresco com folga e
 * não depende de espera.
 */
const INGEST_AT = new Date(Date.now() - 10 * 60 * 1000);

/** Um segundo run, cinco minutos depois: `last_seen_at` avança, `first_seen_at` não. */
const INGEST_AGAIN_AT = new Date(Date.now() - 5 * 60 * 1000);

/** A consulta que casa com `webapp-testing` (nome e resumo falam de teste). */
const QUERY = 'testing';

const REQUEST_ID = /^req_[0-9A-Z]{26}$/;
const SEARCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SKILL_ID = /^sk_[a-z0-9]{20}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** Linha de `search_request` como ela existe no banco (status é enum -> text). */
interface StoredRow {
  request_id: string;
  search_id: string;
  query_hash: string;
  query_text: string | null;
  result_ids: bigint[];
  candidates_count: number | null;
  llm_status: string | null;
  degraded: boolean;
  status: string;
}

/** Linha de `skill` que a idempotência precisa comparar entre dois runs. */
interface SkillRow {
  id: bigint;
  source_key: string;
  first_seen_at: Date;
  last_seen_at: Date;
  is_active: boolean;
}

function first<T>(items: readonly T[]): T {
  const [item] = items;
  if (item === undefined) {
    throw new Error('lista vazia');
  }
  return item;
}

function mustDecode(skillId: string): bigint {
  const decoded = decodeSkillId(skillId);
  if (decoded === null) {
    throw new Error(`skill_id fora do formato publico: ${skillId}`);
  }
  return decoded;
}

function resultIds(body: SearchResponse): string[] {
  return body.results.map((item) => item.skill.skill_id);
}

function textOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const { code, message } = error as { code?: unknown; message?: unknown };
    return [code, message].filter((part) => typeof part === 'string').join(' ');
  }
  return String(error);
}

describe('search flow over real Postgres (issue #12)', () => {
  let prisma: PrismaClient;
  let app: INestApplication | undefined;
  /** `true` só depois do advisory lock: o `afterAll` não pode soltar o que não pegou. */
  let locked = false;

  /** Ingestão da fixture inteira, com relógio injetado. */
  function ingestFixture(startedAt: Date = INGEST_AT): Promise<IngestRunOutcome> {
    return ingest({
      source: createFixtureSource(),
      repository: new PrismaCatalogRepository(prisma),
      adapter: 'fixture',
      startedAt,
      now: () => startedAt,
    });
  }

  function count(table: 'skill' | 'ingest_run' | 'skill_metric_snapshot'): Promise<number> {
    return prisma
      .$queryRawUnsafe<Array<{ total: number }>>(`SELECT count(*)::int AS total FROM "${table}"`)
      .then((rows) => first(rows).total);
  }

  function skillRows(): Promise<SkillRow[]> {
    return prisma.$queryRaw<SkillRow[]>`
      SELECT id, source_key, first_seen_at, last_seen_at, is_active
        FROM "skill"
       ORDER BY source_key
    `;
  }

  /** Servidor HTTP do app; falha alto se o `beforeAll` não chegou a subir. */
  function httpServer(): Server {
    if (app === undefined) {
      throw new Error('a aplicacao nao subiu: nao ha servidor HTTP para o supertest');
    }
    return app.getHttpServer() as Server;
  }

  function postSearch(body: unknown): request.Test {
    return request(httpServer()).post('/api/v1/search').send(body as object);
  }

  function get(path: string): request.Test {
    return request(httpServer()).get(path);
  }

  beforeAll(async () => {
    // Pool de uma conexão: é o que mantém o advisory lock na mesma sessão.
    prisma = createTestPrismaClient(serializedTestDatabaseUrl());
    await assertDatabase(prisma);
    await lockTestDatabase(prisma);
    locked = true;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    // Porta efêmera fixada uma vez: `Promise.all` de dois supertest no mesmo
    // servidor não pode disputar o `listen(0)`.
    await app.listen(0);
  }, 900_000);

  afterAll(async () => {
    // Limpeza tolerante: quando o banco não está no ar o `beforeAll` lança antes
    // de tudo, e um `afterAll` que estoura em cima esconderia a mensagem certa
    // (a de `db.ts`) atrás de um "cannot read property of undefined".
    await app?.close();
    if (locked) {
      await unlockTestDatabase(prisma);
    }
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  describe('ingest', () => {
    it(
      'writes every fixture row and the second run is idempotent',
      async () => {
        const firstRun = await ingestFixture();

        expect(firstRun.status).toBe('ok');
        expect(firstRun.items_seen).toBe(FIXTURE_SIZE);
        expect(firstRun.items_upserted).toBe(FIXTURE_SIZE);
        expect(firstRun.items_deactivated).toBe(0);
        expect(firstRun.error_code).toBeNull();

        const afterFirst = await skillRows();
        expect(afterFirst).toHaveLength(FIXTURE_SIZE);
        expect(afterFirst.every((row) => row.is_active)).toBe(true);
        // O run fica fechado como `ok` — não `running` para sempre.
        expect(await count('ingest_run')).toBe(1);
        const runs = await prisma.$queryRaw<Array<{ status: string; items_seen: number | null }>>`
          SELECT status::text AS status, items_seen FROM "ingest_run"
        `;
        expect(first(runs).status).toBe('ok');
        expect(first(runs).items_seen).toBe(FIXTURE_SIZE);
        // Primeira execução: uma linha de série por skill.
        expect(await count('skill_metric_snapshot')).toBe(FIXTURE_SIZE);

        const secondRun = await ingestFixture(INGEST_AGAIN_AT);

        expect(secondRun.status).toBe('ok');
        expect(secondRun.items_seen).toBe(FIXTURE_SIZE);
        expect(secondRun.items_upserted).toBe(FIXTURE_SIZE);
        expect(secondRun.items_deactivated).toBe(0);

        const afterSecond = await skillRows();
        // Mesmas linhas, mesmos ids: `ON CONFLICT DO UPDATE`, nunca apaga e insere.
        expect(afterSecond.map((row) => String(row.id))).toEqual(
          afterFirst.map((row) => String(row.id)),
        );
        // `first_seen_at` preservado pelo `LEAST`; `last_seen_at` avança para o
        // `startedAt` do segundo run.
        expect(afterSecond.map((row) => row.first_seen_at.toISOString())).toEqual(
          afterFirst.map((row) => row.first_seen_at.toISOString()),
        );
        expect(
          afterSecond.every((row) => row.last_seen_at.toISOString() === INGEST_AGAIN_AT.toISOString()),
        ).toBe(true);
        expect(await count('skill')).toBe(FIXTURE_SIZE);
        expect(await count('ingest_run')).toBe(2);
        // Métrica idêntica: a série **não** ganha linha nova no rerun.
        expect(await count('skill_metric_snapshot')).toBe(FIXTURE_SIZE);
      },
      90_000,
    );

    it(
      'the database, not the application, refuses a second row with the same source_key',
      async () => {
        await ingestFixture();
        const before = await count('skill');
        const key = 'vercel-labs/skills/find-skills';

        // Prova de que a idempotência acima não depende só do SQL do upsert: a
        // coluna é `UNIQUE`, então um INSERT cru da mesma chave é recusado.
        const rejected = await prisma
          .$executeRaw`
            INSERT INTO "skill" (source_key, name, first_seen_at, last_seen_at)
            VALUES (${key}, ${'duplicata'}, ${INGEST_AT}, ${INGEST_AT})
          `
          .then(
            () => null,
            (error: unknown) => error,
          );

        expect(rejected).not.toBeNull();
        expect(textOf(rejected)).toMatch(/unique|duplicate|23505|constraint/i);
        expect(await count('skill')).toBe(before);
      },
      90_000,
    );
  });

  describe('the five public routes over Postgres', () => {
    beforeEach(async () => {
      await ingestFixture();
    });

    it(
      'POST /search -> GET /searches/{request_id} -> GET /skills/{skill_id}',
      async () => {
        const created = await postSearch({ query: QUERY, limit: 5 }).expect(200);
        const body = created.body as SearchResponse;

        expect(body.request_id).toMatch(REQUEST_ID);
        expect(body.search_id).toMatch(SEARCH_ID);
        expect(body.results.length).toBeGreaterThan(0);
        expect(resultIds(body).every((id) => SKILL_ID.test(id))).toBe(true);
        // O casamento é do Postgres (FTS/`ILIKE` sobre `search_doc`/`name`).
        expect(body.results.some((item) => item.skill.name === 'webapp-testing')).toBe(true);
        const scores = body.results.map((item) => item.score);
        expect(scores).toEqual([...scores].sort((left, right) => right - left));
        // `LLM_ENABLED=false`: degradação visível (regra 7), nunca silêncio.
        expect(body.llm.status).toBe('disabled');
        expect(body.data.degraded).toBe(true);
        expect(body.data.degraded_reason).toBe('llm_unavailable');
        expect(body.data.catalog_snapshot).toMatch(RFC3339);

        const replay = await get(`/api/v1/searches/${body.request_id}`).expect(200);
        expect(replay.body.request_id).toBe(body.request_id);
        expect(replay.body.search_id).toBe(body.search_id);
        expect(replay.body.llm.cached).toBe(true);
        expect(replay.body.llm.model).toBeNull();
        expect(resultIds(replay.body as SearchResponse)).toEqual(resultIds(body));

        // A linha existe em `search_request`, com os ids do banco (BIGINT[]).
        const rows = await prisma.$queryRaw<StoredRow[]>`
          SELECT request_id, id::text AS search_id, query_hash, query_text, result_ids,
                 candidates_count, llm_status, degraded, status::text AS status
            FROM "search_request"
        `;
        expect(rows).toHaveLength(1);
        const row = first(rows);
        expect(row.request_id).toBe(body.request_id);
        expect(row.search_id).toBe(body.search_id);
        expect(row.query_hash).toBe(sha256Hex(QUERY));
        // §8.5: sem `SEARCH_LOG_STORE_TEXT` o histórico guarda só o hash.
        expect(row.query_text).toBeNull();
        expect(row.result_ids.map(String)).toEqual(resultIds(body).map((id) => String(mustDecode(id))));
        expect(row.candidates_count).toBeGreaterThanOrEqual(body.results.length);
        expect(row.llm_status).toBe('disabled');
        expect(row.degraded).toBe(true);
        expect(row.status).toBe('degraded');

        // E o detalhe da primeira skill atravessa `skill` + `skill_document`.
        const topId = first(resultIds(body));
        const detail = await get(`/api/v1/skills/${topId}`).expect(200);
        const data = detail.body.data as SkillDetail;
        expect(data.skill_id).toBe(topId);
        expect(detail.body.request_id).toMatch(REQUEST_ID);
        expect(data.summary).not.toBeNull();
        expect(data.summary?.length).toBeGreaterThan(0);
        expect(data.summary?.length).toBeLessThanOrEqual(280);
        // A fonte `fixture` não publica `SKILL.md`: `null`, não string vazia.
        expect(data.skill_md_excerpt).toBeNull();
      },
      90_000,
    );

    it(
      'an absent metric is null in the column and in the payload, never zero (rule 3)',
      async () => {
        const counts = await prisma.$queryRaw<
          Array<{ rows: number; missing_vulns: number; zero_vulns: number; missing_repo: number }>
        >`
          SELECT count(*)::int AS rows,
                 count(*) FILTER (WHERE vulnerability_count IS NULL)::int AS missing_vulns,
                 count(*) FILTER (WHERE vulnerability_count = 0)::int AS zero_vulns,
                 count(*) FILTER (WHERE repo_url IS NULL)::int AS missing_repo
            FROM "skill"
        `;
        const total = first(counts);
        expect(total.rows).toBe(FIXTURE_SIZE);
        expect(total.missing_vulns).toBe(FIXTURE_SIZE);
        expect(total.zero_vulns).toBe(0);
        expect(total.missing_repo).toBe(FIXTURE_SIZE);

        const page = await get('/api/v1/skills?page_size=100').expect(200);
        const items = page.body.data as SkillSummary[];
        expect(items).toHaveLength(FIXTURE_SIZE);
        // Controle: as outras métricas **vêm** preenchidas, então o `null` de
        // `vulnerability_count` não é vacuidade do fixture inteiro.
        expect(items.some((item) => typeof item.stars === 'number' && item.stars > 0)).toBe(true);
        expect(items.some((item) => typeof item.installs === 'number' && item.installs > 0)).toBe(
          true,
        );
        for (const item of items) {
          expect(item.vulnerability_count).toBeNull();
          expect(item.vulnerability_count).not.toBe(0);
        }

        const detail = await get(`/api/v1/skills/${first(items).skill_id}`).expect(200);
        const data = detail.body.data as SkillDetail;
        expect(data.vulnerability_count).toBeNull();
        expect(data.vulnerability_count).not.toBe(0);
        expect(data.repo_url).toBeNull();
      },
      90_000,
    );

    it(
      'categories come from the table: counts, `position` order and the 422 of an unknown slug',
      async () => {
        // A fixture não traz categorias (`supports_categories: false`) e
        // `skill.category_slug` é FK: a linha de `category` vem primeiro.
        await prisma.$executeRaw`
          INSERT INTO "category" (slug, label_en, position, seen_at) VALUES
            (${'testing'}, ${'Testing'}, ${1}, ${INGEST_AT}),
            (${'dev'}, ${'Developer tools'}, ${2}, ${INGEST_AT})
        `;
        await prisma.$executeRaw`
          UPDATE "skill" SET category_slug = ${'testing'}
           WHERE source_key = ${'anthropics/skills/webapp-testing'}
        `;
        await prisma.$executeRaw`
          UPDATE "skill" SET category_slug = ${'dev'}
           WHERE source_key = ${'vercel-labs/skills/find-skills'}
        `;

        const listed = await get('/api/v1/categories').expect(200);
        expect(listed.body.data).toEqual([
          { slug: 'testing', label_en: 'Testing', skill_count: 1 },
          { slug: 'dev', label_en: 'Developer tools', skill_count: 1 },
        ]);
        expect(listed.body.data_snapshot).toMatch(RFC3339);

        const filtered = await postSearch({ query: QUERY, category: 'testing' }).expect(200);
        expect(filtered.body.results.length).toBeGreaterThan(0);
        for (const item of filtered.body.results as SearchResponse['results']) {
          expect(item.skill.category).toBe('testing');
        }

        // D-A: o slug é um enum fechado, e quem responde é a tabela `category`.
        const unknown = await postSearch({ query: QUERY, category: 'nao-existe' }).expect(422);
        expect(unknown.body.error.code).toBe('VALIDATION_ERROR');
        expect(unknown.body.error.details.reason).toBe('UNKNOWN_CATEGORY');
      },
      90_000,
    );

    it(
      'answers 503 on the search and on the category list when the catalog was never ingested',
      async () => {
        // Banco vazio: `max(last_seen_at)` não devolve linha, então o snapshot é
        // `null` — e `null` não é "catálogo de hoje", é 503.
        await truncateAll(prisma);

        const search = await postSearch({ query: QUERY }).expect(503);
        expect(search.body.error.code).toBe('SOURCE_UNAVAILABLE');
        expect(search.body.error.details.reason).toBe('cache_empty');

        const categories = await get('/api/v1/categories').expect(503);
        expect(categories.body.error.code).toBe('SOURCE_UNAVAILABLE');
        expect(categories.body.error.details.reason).toBe('cache_empty');

        // Sem catálogo não existe `data_snapshot` honesto nem histórico gravado.
        const stored = await prisma.$queryRaw<Array<{ total: number }>>`
          SELECT count(*)::int AS total FROM "search_request"
        `;
        expect(first(stored).total).toBe(0);
      },
      90_000,
    );

    it(
      'GET /skills sorts with NULLS LAST and paginates with the total of the filter',
      async () => {
        // Uma skill sem métrica: `NULLS LAST` é do `ORDER BY`, e o campo
        // continua `null` no payload (regra 3) em vez de virar 0.
        await prisma.$executeRaw`
          UPDATE "skill" SET stars = NULL
           WHERE source_key = ${'nexu-io/open-design/imagegen-frontend-web'}
        `;

        const page = await get('/api/v1/skills?sort_by=stars&page_size=3').expect(200);
        expect(page.body.data.map((item: SkillSummary) => item.name)).toEqual([
          'webapp-testing',
          'godot-gdscript-patterns',
          'find-skills',
        ]);
        expect(page.body.pagination).toEqual({
          page: 1,
          page_size: 3,
          total_items: FIXTURE_SIZE,
          total_pages: 9,
        });

        const secondPage = await get('/api/v1/skills?sort_by=stars&page=2&page_size=3').expect(200);
        const firstPageNames = (page.body.data as SkillSummary[]).map((item) => item.name);
        const secondPageNames = (secondPage.body.data as SkillSummary[]).map((item) => item.name);
        expect(secondPageNames).toHaveLength(3);
        // Sem `OFFSET` repetindo linha entre páginas.
        expect(secondPageNames.filter((name) => firstPageNames.includes(name))).toEqual([]);
        // A ordenação continua decrescente atravessando a fronteira das páginas.
        const starsAcrossPages = [
          ...(page.body.data as SkillSummary[]),
          ...(secondPage.body.data as SkillSummary[]),
        ]
          .map((item) => item.stars)
          .filter((stars): stars is number => stars !== null);
        expect(starsAcrossPages).toHaveLength(6);
        expect(starsAcrossPages).toEqual([...starsAcrossPages].sort((left, right) => right - left));

        // Última página: a linha sem métrica, com `stars: null` — nunca 0.
        const lastPage = await get('/api/v1/skills?sort_by=stars&page=9&page_size=3').expect(200);
        const tail = lastPage.body.data as SkillSummary[];
        expect(tail).toHaveLength(1);
        expect(first(tail).name).toBe('imagegen-frontend-web');
        expect(first(tail).stars).toBeNull();
        expect(first(tail).stars).not.toBe(0);

        const byName = await get('/api/v1/skills?sort_by=name&page_size=100').expect(200);
        const names = byName.body.data.map((item: SkillSummary) => item.name);
        expect(names).toHaveLength(FIXTURE_SIZE);
        expect(names).toEqual([...names].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)));
      },
      90_000,
    );
  });
});
