/**
 * Issue #12, AC2 — **duas buscas simultâneas** contra Postgres real.
 *
 * O cenário é o da issue: dois pedidos de `/api/v1/search` disparam juntos
 * (`Promise.all`), com o mesmo corpo, no mesmo processo e no mesmo pool. O que
 * este spec prova é que a concorrência não colapsa a identidade nem a
 * persistência:
 *
 * - os dois respondem `200`;
 * - `request_id` **e** `search_id` são distintos entre eles (o `request_id` é
 *   cunhado no serviço, decisão C4; o `search_id` é o `id uuid` do banco, e um
 *   `uuid` reusado faria dois permalinks apontarem para a mesma linha);
 * - as **duas** linhas ficam em `search_request` — não uma sobrescrita;
 * - os **dois** permalinks resolvem, cada um com o seu conteúdo;
 * - a ordenação das duas respostas é idêntica: o ranking é determinístico
 *   (regra 1), então a corrida não pode mudar a ordem.
 *
 * O título carrega o token ASCII `concorrencia` para que
 * `jest -t concorrencia` rode só este caso.
 */
import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';

import { AppModule } from '@/app.module';
import { createFixtureSource } from '@/catalog/fixture-source';
import { ingest } from '@/catalog/ingest';
import { PrismaCatalogRepository } from '@/catalog/prisma-catalog.repository';
import type { SearchResponse } from '@/contract/dto/search-response.dto';
import { configureApp } from '@/main';

import { assertDatabase, createTestPrismaClient, truncateAll } from './db';
import { lockTestDatabase, serializedTestDatabaseUrl, unlockTestDatabase } from './serial';

/**
 * Relógio injetado e **relativo**: a busca compara o snapshot com `new Date()`
 * (limite de 6 h), então um instante cravado no calendário apodreceria. Dez
 * minutos atrás é fresco com folga, e as duas buscas veem o mesmo snapshot.
 */
const INGEST_AT = new Date(Date.now() - 10 * 60 * 1000);

/** Consulta que casa com `webapp-testing` (o `-t` do Jest é regex: sem `(`/`)`). */
const QUERY = 'testing';

const REQUEST_ID = /^req_[0-9A-Z]{26}$/;
const SEARCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface StoredSearchRow {
  request_id: string;
  search_id: string;
  result_ids: bigint[];
}

function first<T>(items: readonly T[]): T {
  const [item] = items;
  if (item === undefined) {
    throw new Error('lista vazia');
  }
  return item;
}

function resultIds(body: SearchResponse): string[] {
  return body.results.map((item) => item.skill.skill_id);
}

describe('two simultaneous searches (concorrencia) over real Postgres', () => {
  let prisma: PrismaClient;
  let app: INestApplication | undefined;
  /** `true` só depois do advisory lock: o `afterAll` não solta o que não pegou. */
  let locked = false;

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
    prisma = createTestPrismaClient(serializedTestDatabaseUrl());
    await assertDatabase(prisma);
    await lockTestDatabase(prisma);
    locked = true;
    await truncateAll(prisma);

    const outcome = await ingest({
      source: createFixtureSource(),
      repository: new PrismaCatalogRepository(prisma),
      adapter: 'fixture',
      startedAt: INGEST_AT,
      now: () => INGEST_AT,
    });
    // Pré-condição das asserções: o catálogo tem de estar ingerido, senão a
    // busca responderia 503 e o teste de concorrência não teria objeto.
    expect(outcome.status).toBe('ok');
    expect(outcome.items_upserted).toBeGreaterThan(0);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    // Porta efêmera fixada **antes** do `Promise.all`: dois supertest no mesmo
    // servidor não podem disputar o `listen(0)`.
    await app.listen(0);
  }, 900_000);

  afterAll(async () => {
    // Limpeza tolerante: banco fora do ar falha em `assertDatabase` antes do
    // app existir, e o `afterAll` não pode esconder a mensagem de `db.ts`.
    await app?.close();
    if (locked) {
      await unlockTestDatabase(prisma);
    }
    await prisma.$disconnect();
  });

  it(
    'dispara duas buscas ao mesmo tempo: request_id e search_id distintos, 2 linhas, 2 permalinks (concorrencia)',
    async () => {
      const body = { query: QUERY, limit: 5 };

      const responses = await Promise.all([postSearch(body), postSearch(body)]);
      const [left, right] = responses;
      if (left === undefined || right === undefined) {
        throw new Error('Promise.all devolveu menos de duas respostas');
      }

      expect(left.status).toBe(200);
      expect(right.status).toBe(200);

      const firstBody = left.body as SearchResponse;
      const secondBody = right.body as SearchResponse;

      // Identidade: cada busca tem o seu par (request_id, search_id).
      expect(firstBody.request_id).toMatch(REQUEST_ID);
      expect(secondBody.request_id).toMatch(REQUEST_ID);
      expect(firstBody.request_id).not.toBe(secondBody.request_id);
      expect(firstBody.search_id).toMatch(SEARCH_ID);
      expect(secondBody.search_id).toMatch(SEARCH_ID);
      expect(firstBody.search_id).not.toBe(secondBody.search_id);

      // O header ecoa o id do corpo em cada resposta: dois valores, dois corpos.
      expect(left.headers['x-request-id']).toBe(firstBody.request_id);
      expect(right.headers['x-request-id']).toBe(secondBody.request_id);

      // Conteúdo: as duas buscaram o mesmo catálogo, na mesma ordem (regra 1).
      expect(resultIds(firstBody).length).toBeGreaterThan(0);
      expect(resultIds(secondBody)).toEqual(resultIds(firstBody));
      expect(firstBody.results.map((item) => item.score)).toEqual(
        secondBody.results.map((item) => item.score),
      );

      // Persistência: **duas** linhas, não uma sobrescrita pela outra.
      const rows = await prisma.$queryRaw<StoredSearchRow[]>`
        SELECT request_id, id::text AS search_id, result_ids
          FROM "search_request"
         ORDER BY request_id
      `;
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => row.request_id)).size).toBe(2);
      expect(new Set(rows.map((row) => row.search_id)).size).toBe(2);
      // As duas linhas gravaram resultado: nenhuma delas é um registro vazio.
      for (const row of rows) {
        expect(row.result_ids.length).toBe(resultIds(firstBody).length);
      }

      // Os dois permalinks resolvem — e cada um devolve o seu próprio par de ids.
      const replayLeft = await get(`/api/v1/searches/${firstBody.request_id}`).expect(200);
      const replayRight = await get(`/api/v1/searches/${secondBody.request_id}`).expect(200);

      expect(replayLeft.body.request_id).toBe(firstBody.request_id);
      expect(replayLeft.body.search_id).toBe(firstBody.search_id);
      expect(replayRight.body.request_id).toBe(secondBody.request_id);
      expect(replayRight.body.search_id).toBe(secondBody.search_id);
      expect(replayLeft.body.search_id).not.toBe(replayRight.body.search_id);
      expect(resultIds(replayLeft.body as SearchResponse)).toEqual(resultIds(firstBody));
      expect(resultIds(replayRight.body as SearchResponse)).toEqual(resultIds(secondBody));
      expect(replayLeft.body.llm.cached).toBe(true);
      expect(replayRight.body.llm.cached).toBe(true);

      // E o conjunto de ids gravados é o mesmo nas duas linhas: catálogo estável
      // durante a corrida, sem leitura parcial de uma transação alheia.
      const storedIds = rows.map((row) => row.result_ids.map(String).join(','));
      expect(new Set(storedIds).size).toBe(1);
      expect(first(storedIds).length).toBeGreaterThan(0);
    },
    90_000,
  );
});
