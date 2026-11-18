/**
 * Issue #7 — ingestão idempotente do catálogo: orquestração do `IngestRun`.
 *
 * Sem banco, sem docker, sem rede: o repositório é **em memória** (implementado aqui, abaixo) e a
 * fonte é a fixture congelada. O que está sob teste não é o SQL — é a regra de decisão do run.
 *
 * Contrato exigido do código de produção:
 *
 *   // backend/src/catalog/catalog-repository.ts — porta de persistência
 *   export interface CatalogRepository {
 *     failStaleRuns(startedBefore: Date): Promise<number>;      // status 'failed', error_code 'STALE_RUN'
 *     startRun(run: { adapter: string; started_at: Date }): Promise<number>;
 *     finishRun(id: number, patch: IngestRunFinish): Promise<void>;
 *     countActiveSkills(): Promise<number>;                     // is_active = true
 *     upsertSkills(skills: SkillRecord[], seenAt: Date): Promise<number>;   // ON CONFLICT (source_key)
 *     deactivateSkillsNotSeenSince(seenAt: Date): Promise<number>;          // last_seen_at < seenAt
 *   }
 *   export interface IngestRunFinish {
 *     status: 'ok' | 'partial' | 'failed'; finished_at: Date;
 *     items_seen: number; items_upserted: number; items_deactivated: number;
 *     error_code?: string | null; error_detail?: string | null;
 *   }
 *
 *   // backend/src/catalog/ingest.ts — orquestrador, relógio injetado
 *   export function ingest(options: {
 *     source: SkillSource; repository: CatalogRepository;
 *     adapter: string; startedAt: Date;
 *   }): Promise<IngestRunOutcome>;   // { status, items_seen, items_upserted, items_deactivated,
 *                                    //   error_code, error_detail, started_at, finished_at }
 *
 * Tabela ratificada pelo `architect` (`docs/app/02-arquitetura.md` §7.3), transições
 * `running -> ok | partial | failed`, com `startedAt` injetado:
 *
 *   | condição                                                          | status  |
 *   | fonte lança antes de gravar / items_upserted == 0 com erro          | failed  |
 *   | items_seen == 0, alguma página falhou, ou upserted/seen < 0,5       | partial |
 *   | caso contrário, com items_seen >= 1                                | ok      |
 *
 * Desativação **só** em `ok` **e** quando `items_seen >= 0,8 × ativos`, numa única statement
 * (`last_seen_at < startedAt`); `last_seen_at = startedAt` para toda linha tocada e o upsert
 * também seta `is_active = true`. Antes de abrir o run, todo `running` com
 * `started_at < startedAt - 2h` vira `failed` com `error_code = 'STALE_RUN'`.
 */
import * as net from 'node:net';

import type {
  CatalogRepository,
  IngestRunFinish,
  IngestRunRow,
  RotationParams,
} from '@/catalog/catalog-repository';
import { INGEST_ERROR_CODES } from '@/catalog/catalog-repository';
import { createFixtureSource } from '@/catalog/fixture-source';
import { ingest, MAX_PAGES } from '@/catalog/ingest';
import type { SkillRecord, SkillSource } from '@/catalog/skill-source';

/** Relógio fixo: o orquestrador nunca lê o relógio sozinho. */
const T1 = new Date('2026-11-15T00:00:00.000Z');
const T2 = new Date('2026-11-15T06:00:00.000Z');
const T3 = new Date('2026-11-15T12:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;

const FIXTURE_ITEMS = 25;

/** Linha de `skill` como o repositório em memória a guarda (campos que a ingestão toca). */
interface StoredSkill {
  source_key: string;
  name: string;
  summary: string | null;
  installs: number | null;
  stars: number | null;
  vulnerability_count: number | null;
  source_url: string | null;
  repo_url: string | null;
  first_seen_at: Date;
  last_seen_at: Date;
  is_active: boolean;
}

type StoredRun = IngestRunRow;

/**
 * Repositório em memória: mesma semântica das statements do Postgres, sem Postgres.
 *
 * `upsertSkills` chaveia por `source_key`, como `INSERT ... ON CONFLICT (source_key) DO UPDATE`;
 * `deactivateSkillsNotSeenSince` desativa por `last_seen_at < seenAt`, como a statement única
 * ratificada — nunca por lista de ids.
 */
class InMemoryCatalogRepository implements CatalogRepository {
  private readonly skills = new Map<string, StoredSkill>();
  private readonly runs: StoredRun[] = [];
  private nextRunId = 1;

  /** Chamadas de upsert, para provar que a 2ª execução regrava os mesmos 25 itens. */
  readonly upsertCalls: string[][] = [];

  get skillRows(): ReadonlyMap<string, StoredSkill> {
    return this.skills;
  }

  get runRows(): readonly StoredRun[] {
    return this.runs;
  }

  activeCount(): number {
    return [...this.skills.values()].filter((skill) => skill.is_active).length;
  }

  failStaleRuns(startedBefore: Date): Promise<number> {
    let failed = 0;
    for (const run of this.runs) {
      if (run.status === 'running' && run.started_at.getTime() < startedBefore.getTime()) {
        run.status = 'failed';
        run.error_code = 'STALE_RUN';
        failed += 1;
      }
    }
    return Promise.resolve(failed);
  }

  startRun(run: {
    adapter: string;
    started_at: Date;
    items_requested?: number | null;
  }): Promise<number> {
    const id = this.nextRunId;
    this.nextRunId += 1;
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
    const run = this.runs.find((candidate) => candidate.id === id);
    if (run === undefined) {
      throw new Error(`ingest_run ${String(id)} não existe`);
    }
    run.status = patch.status;
    run.finished_at = patch.finished_at;
    run.items_seen = patch.items_seen;
    run.items_upserted = patch.items_upserted;
    run.items_deactivated = patch.items_deactivated;
    run.error_code = patch.error_code ?? null;
    run.error_detail = patch.error_detail ?? null;
    return Promise.resolve();
  }

  countActiveSkills(): Promise<number> {
    return Promise.resolve(this.activeCount());
  }

  upsertSkills(skills: SkillRecord[], seenAt: Date): Promise<number> {
    this.upsertCalls.push(skills.map((skill) => skill.source_key));
    for (const skill of skills) {
      const existing = this.skills.get(skill.source_key);
      this.skills.set(skill.source_key, {
        source_key: skill.source_key,
        name: skill.name,
        summary: skill.summary ?? null,
        installs: skill.installs ?? null,
        stars: skill.stars ?? null,
        vulnerability_count: skill.vulnerability_count ?? null,
        source_url: skill.source_url ?? null,
        repo_url: skill.repo_url ?? null,
        first_seen_at: existing?.first_seen_at ?? seenAt,
        last_seen_at: seenAt,
        is_active: true,
      });
    }
    return Promise.resolve(skills.length);
  }

  /**
   * O rodízio (issue #45) não é chamado pela ingestão desta suíte: a seleção de
   * chaves tem spec próprio. O duplo responde vazio para a porta ficar completa.
   */
  selectRotationKeys(_params: RotationParams): Promise<string[]> {
    return Promise.resolve([]);
  }

  deactivateSkillsNotSeenSince(seenAt: Date): Promise<number> {
    return this.deactivateSkillsStaleBefore(seenAt);
  }

  deactivateSkillsStaleBefore(cutoff: Date): Promise<number> {
    let deactivated = 0;
    for (const skill of this.skills.values()) {
      if (skill.is_active && skill.last_seen_at.getTime() < cutoff.getTime()) {
        skill.is_active = false;
        deactivated += 1;
      }
    }
    return Promise.resolve(deactivated);
  }
}

function page(items: SkillRecord[], pageNumber: number, hasMore: boolean) {
  return { items, page: pageNumber, has_more: hasMore };
}

/**
 * Repositório cujo `upsertSkills` lança — banco fora do ar no meio do run.
 *
 * A tabela do §7.3 é explícita: repositório que lança fecha o run como `failed`
 * com `REPOSITORY_FAILED`; o run **não** pode ficar `running` esperando o
 * `failStaleRuns` de duas horas depois. O resto da porta delega ao repositório
 * em memória, para que o histórico do run continue auditável.
 */
class FailingUpsertRepository implements CatalogRepository {
  constructor(private readonly inner: InMemoryCatalogRepository) {}

  failStaleRuns(startedBefore: Date): Promise<number> {
    return this.inner.failStaleRuns(startedBefore);
  }

  startRun(run: { adapter: string; started_at: Date }): Promise<number> {
    return this.inner.startRun(run);
  }

  finishRun(id: number, patch: IngestRunFinish): Promise<void> {
    return this.inner.finishRun(id, patch);
  }

  countActiveSkills(): Promise<number> {
    return this.inner.countActiveSkills();
  }

  selectRotationKeys(params: RotationParams): Promise<string[]> {
    return this.inner.selectRotationKeys(params);
  }

  upsertSkills(): Promise<number> {
    return Promise.reject(new Error('upsert indisponível: conexão encerrada'));
  }

  deactivateSkillsNotSeenSince(seenAt: Date): Promise<number> {
    return this.inner.deactivateSkillsNotSeenSince(seenAt);
  }

  deactivateSkillsStaleBefore(cutoff: Date): Promise<number> {
    return this.inner.deactivateSkillsStaleBefore(cutoff);
  }
}

/** Repositório que só persiste 5 dos 25 itens: razão upserted/seen = 0,2. */
class LowRatioRepository extends InMemoryCatalogRepository {
  override upsertSkills(skills: SkillRecord[], seenAt: Date): Promise<number> {
    return super.upsertSkills(skills.slice(0, 5), seenAt);
  }
}

/** Registro mínimo aceito pela ingestão; só `source_key` conta para os números. */
function record(key: string): SkillRecord {
  return {
    source_key: key,
    source_url: `https://skills.sh/${key}`,
    name: key.split('/').at(-1) ?? key,
    summary: null,
    category_slug: null,
    stars: null,
    installs: null,
    vulnerability_count: null,
    security_status: 'unknown',
    repo_url: null,
    skill_md_present: false,
    first_seen_at: null,
    raw: { source_key: key },
  };
}

/** Fonte que nunca desliga `has_more`: cada página traz uma chave inédita. */
function endlessSource(): SkillSource {
  return {
    capabilities: { supports_categories: false, supports_documents: false },
    listCategories: () => Promise.resolve([]),
    fetchSkills: () => Promise.resolve([]),
    fetchCatalog: (pageNumber: number) =>
      Promise.resolve(page([record(`owner/repo/skill-${String(pageNumber)}`)], pageNumber, true)),
    fetchDocument: () => Promise.resolve(null),
  };
}

/** Fonte que entrega exatamente estes itens na página 1 e nada depois. */
function staticSource(items: SkillRecord[]): SkillSource {
  return {
    capabilities: { supports_categories: false, supports_documents: false },
    listCategories: () => Promise.resolve([]),
    // A ingestão de hoje pagina; quem pede chaves é o rodízio (#44, #46).
    fetchSkills: () => Promise.resolve([]),
    fetchCatalog: (pageNumber: number) =>
      Promise.resolve(pageNumber === 1 ? page(items, 1, false) : page([], pageNumber, false)),
    fetchDocument: () => Promise.resolve(null),
  };
}

/** Fonte que lança antes de entregar qualquer item (site fora do ar, HTML quebrado). */
function throwingSource(error: Error): SkillSource {
  return {
    capabilities: { supports_categories: false, supports_documents: false },
    listCategories: () => Promise.resolve([]),
    fetchSkills: () => Promise.resolve([]),
    fetchCatalog: () => Promise.reject(error),
    fetchDocument: () => Promise.resolve(null),
  };
}

/**
 * Fonte que rejeita com **texto**, não com `Error` — acontece com cliente HTTP e
 * lib de terceiro. O orquestrador tem de registrar a mensagem, não `[object
 * Object]` nem uma exceção no meio do run.
 */
function rejectingWithTextSource(text: string): SkillSource {
  return {
    capabilities: { supports_categories: false, supports_documents: false },
    listCategories: () => Promise.resolve([]),
    fetchSkills: () => Promise.resolve([]),
    // Rejeitar com string (não `Error`) é o CASO TESTADO: a ingestão não pode
    // depender de a fonte ser bem-comportada. A regra existe para código de
    // produção, onde rejeitar sem `Error` perde stack; aqui é o vetor.
    // A fonte LANCA uma string (nao `Error`): a ingestao nao pode depender de a
    // fonte ser bem-comportada. `prefer-promise-reject-errors` cobre so
    // `Promise.reject`; o vetor aqui e `throw`, e o efeito no catch e o mesmo.
    fetchCatalog: () => {
      // A regra existe para codigo de producao, onde um alvo sem `Error` perde
      // stack. Aqui a string E o vetor: o teste prova que a ingestao nao depende
      // de a fonte lancar um `Error` bem formado.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw text;
    },
    fetchDocument: () => Promise.resolve(null),
  };
}

/** Fonte que entrega uma página parcial e falha na seguinte (página 1 = 5, página 2 lança). */
function firstPageThenThrow(items: SkillRecord[], error: Error): SkillSource {
  return {
    capabilities: { supports_categories: false, supports_documents: false },
    listCategories: () => Promise.resolve([]),
    fetchSkills: () => Promise.resolve([]),
    fetchCatalog: (pageNumber: number) =>
      pageNumber === 1 ? Promise.resolve(page(items, 1, true)) : Promise.reject(error),
    fetchDocument: () => Promise.resolve(null),
  };
}

/** Os 25 itens da fixture, lidos uma vez por teste. */
async function fixtureItems(): Promise<SkillRecord[]> {
  const { items } = await createFixtureSource().fetchCatalog(1);
  expect(items).toHaveLength(FIXTURE_ITEMS);
  return items;
}

/** Última linha de `ingest_run`, falhando com mensagem clara se nenhuma foi criada. */
function lastRun(repository: InMemoryCatalogRepository): StoredRun {
  const run = repository.runRows[repository.runRows.length - 1];
  if (run === undefined) {
    throw new Error('a ingestão não criou nenhuma linha em ingest_run');
  }
  return run;
}

describe('catalog ingest — IngestRun (docs/app/02-arquitetura.md §7.3)', () => {
  describe('idempotência', () => {
    it('duas execuções da mesma fixture: 25 itens, 25 linhas, sem duplicata', async () => {
      const repository = new InMemoryCatalogRepository();
      const source = createFixtureSource();

      const first = await ingest({ source, repository, adapter: 'fixture', startedAt: T1 });
      expect(first.status).toBe('ok');
      expect(first.items_seen).toBe(FIXTURE_ITEMS);
      expect(first.items_upserted).toBe(FIXTURE_ITEMS);
      expect(repository.skillRows.size).toBe(FIXTURE_ITEMS);

      const second = await ingest({ source, repository, adapter: 'fixture', startedAt: T2 });
      expect(second.status).toBe('ok');
      expect(second.items_seen).toBe(FIXTURE_ITEMS);
      expect(second.items_upserted).toBe(FIXTURE_ITEMS);
      expect(second.items_deactivated).toBe(0);

      // A segunda execução regravou os mesmos 25 — e o catálogo continua com 25, não com 50.
      expect(repository.upsertCalls).toHaveLength(2);
      expect(repository.upsertCalls[0]).toHaveLength(FIXTURE_ITEMS);
      expect(repository.upsertCalls[1]).toHaveLength(FIXTURE_ITEMS);
      expect(new Set(repository.upsertCalls[1]).size).toBe(FIXTURE_ITEMS);
      expect(repository.skillRows.size).toBe(FIXTURE_ITEMS);
    });

    it('a segunda execução atualiza last_seen_at e mantém tudo ativo', async () => {
      const repository = new InMemoryCatalogRepository();
      const source = createFixtureSource();

      await ingest({ source, repository, adapter: 'fixture', startedAt: T1 });
      await ingest({ source, repository, adapter: 'fixture', startedAt: T2 });

      expect(repository.activeCount()).toBe(FIXTURE_ITEMS);
      for (const skill of repository.skillRows.values()) {
        expect(skill.last_seen_at).toEqual(T2);
        expect(skill.is_active).toBe(true);
      }
    });
  });

  describe('run ok', () => {
    it('as duas execuções fecham com started_at e finished_at preenchidos', async () => {
      const repository = new InMemoryCatalogRepository();
      const source = createFixtureSource();

      const first = await ingest({ source, repository, adapter: 'fixture', startedAt: T1 });
      const second = await ingest({ source, repository, adapter: 'fixture', startedAt: T2 });

      expect(first.started_at).toEqual(T1);
      expect(first.finished_at).toBeInstanceOf(Date);
      expect(second.started_at).toEqual(T2);
      expect(second.finished_at).toBeInstanceOf(Date);
      expect(second.finished_at.getTime()).toBeGreaterThanOrEqual(T2.getTime());

      const rows = repository.runRows;
      expect(rows).toHaveLength(2);
      expect(rows[0].adapter).toBe('fixture');
      expect(rows[0].started_at).toEqual(T1);
      expect(rows[0].finished_at).toBeInstanceOf(Date);
      expect(rows[0].status).toBe('ok');
      expect(rows[0].items_seen).toBe(FIXTURE_ITEMS);
      expect(rows[1].started_at).toEqual(T2);
      expect(rows[1].finished_at).toBeInstanceOf(Date);
      expect(rows[1].status).toBe('ok');
    });
  });

  describe('run failed', () => {
    it('fonte lança na 1ª página: failed com error_code e nada desativado', async () => {
      const repository = new InMemoryCatalogRepository();
      await ingest({ source: createFixtureSource(), repository, adapter: 'fixture', startedAt: T1 });
      const activeBefore = repository.activeCount();
      expect(activeBefore).toBe(FIXTURE_ITEMS);

      const failed = await ingest({
        source: throwingSource(new Error('skills.sh respondeu 503')),
        repository,
        adapter: 'fixture',
        startedAt: T2,
      });

      expect(failed.status).toBe('failed');
      expect(typeof failed.error_code).toBe('string');
      expect(failed.error_code).toBeTruthy();
      expect(failed.items_upserted).toBe(0);

      // O catálogo anterior continua inteiro e ativo (§7.3: "is_active não é tocado").
      expect(repository.activeCount()).toBe(FIXTURE_ITEMS);
      for (const skill of repository.skillRows.values()) {
        expect(skill.is_active).toBe(true);
      }

      const run = lastRun(repository);
      expect(run.status).toBe('failed');
      expect(run.error_code).toBeTruthy();
      expect(run.finished_at).toBeInstanceOf(Date);
    });

    /**
     * A fonte respondeu (25 itens lidos), mas o **repositório** lançou no upsert.
     * Sem o `catch` do orquestrador o run ficaria `running` para sempre; com ele,
     * fecha `failed` / `REPOSITORY_FAILED` e o catálogo anterior fica intacto.
     */
    it('repositório lançando no upsert fecha o run como failed/REPOSITORY_FAILED', async () => {
      const repository = new InMemoryCatalogRepository();
      await ingest({ source: createFixtureSource(), repository, adapter: 'fixture', startedAt: T1 });
      const activeBefore = repository.activeCount();
      expect(activeBefore).toBe(FIXTURE_ITEMS);

      // O mesmo repositório guarda o run e recusa o upsert: `lastRun` prova o
      // fechamento, não só o objeto devolvido pelo orquestrador.
      const result = await ingest({
        source: createFixtureSource(),
        repository: new FailingUpsertRepository(repository),
        adapter: 'fixture',
        startedAt: T2,
      });

      expect(result.status).toBe('failed');
      expect(result.error_code).toBe(INGEST_ERROR_CODES.repositoryFailed);
      expect(result.error_detail).toContain('upsert indisponível');
      expect(result.items_seen).toBe(FIXTURE_ITEMS);
      expect(result.items_upserted).toBe(0);
      expect(result.items_deactivated).toBe(0);

      const run = lastRun(repository);
      expect(run.status).toBe('failed');
      expect(run.error_code).toBe(INGEST_ERROR_CODES.repositoryFailed);
      expect(run.finished_at).toBeInstanceOf(Date);
      expect(run.started_at).toEqual(T2);
      // Nada foi desativado: run `failed` não toca em `is_active` (§7.3).
      expect(repository.activeCount()).toBe(activeBefore);
    });

    /**
     * `error_detail` tem teto de 500 caracteres (coluna e log). Uma mensagem de
     * driver com stack colada não pode virar quilobytes na linha do run — e o
     * começo do texto, que é o que identifica a falha, tem de sobreviver ao corte.
     */
    it('mensagem de erro acima de 500 caracteres é truncada no error_detail', async () => {
      const repository = new InMemoryCatalogRepository();

      const result = await ingest({
        source: throwingSource(new Error(`falha do driver: ${'x'.repeat(600)}`)),
        repository,
        adapter: 'fixture',
        startedAt: T1,
      });

      expect(result.status).toBe('failed');
      expect(result.error_detail).toHaveLength(500);
      expect(result.error_detail?.startsWith('falha do driver:')).toBe(true);

      const run = lastRun(repository);
      expect(run.error_code).toBe(INGEST_ERROR_CODES.sourceFetchFailed);
      expect(run.error_detail).toHaveLength(500);
    });

    it('rejeição com texto (não Error) é registrada como failed, sem virar [object Object]', async () => {
      const repository = new InMemoryCatalogRepository();

      const result = await ingest({
        source: rejectingWithTextSource('timeout de leitura do socket'),
        repository,
        adapter: 'fixture',
        startedAt: T1,
      });

      expect(result.status).toBe('failed');
      expect(result.error_code).toBe(INGEST_ERROR_CODES.sourceFetchFailed);
      expect(result.error_detail).toBe('timeout de leitura do socket');
    });
  });

  describe('desativação por last_seen_at', () => {
    it('2ª execução vê 24 de 25: ok e exatamente 1 desativada', async () => {
      const repository = new InMemoryCatalogRepository();
      const all = await fixtureItems();
      const seen = all.slice(0, FIXTURE_ITEMS - 1);
      const missing = all[FIXTURE_ITEMS - 1];

      await ingest({ source: createFixtureSource(), repository, adapter: 'fixture', startedAt: T1 });

      const second = await ingest({
        source: staticSource(seen),
        repository,
        adapter: 'fixture',
        startedAt: T2,
      });

      expect(second.status).toBe('ok');
      expect(second.items_seen).toBe(FIXTURE_ITEMS - 1);
      expect(second.items_upserted).toBe(FIXTURE_ITEMS - 1);
      expect(second.items_deactivated).toBe(1);
      expect(repository.activeCount()).toBe(FIXTURE_ITEMS - 1);

      const gone = repository.skillRows.get(missing.source_key);
      expect(gone?.is_active).toBe(false);
      for (const key of seen.map((item) => item.source_key)) {
        expect(repository.skillRows.get(key)?.is_active).toBe(true);
      }
    });
  });

  describe('run partial', () => {
    it('fonte devolve 5 de 25 com página falhando: partial e nenhum is_active alterado', async () => {
      const repository = new InMemoryCatalogRepository();
      const all = await fixtureItems();
      const five = all.slice(0, 5);

      await ingest({ source: createFixtureSource(), repository, adapter: 'fixture', startedAt: T1 });

      const partial = await ingest({
        source: firstPageThenThrow(five, new Error('timeout na página 2')),
        repository,
        adapter: 'fixture',
        startedAt: T2,
      });

      expect(partial.status).toBe('partial');
      expect(partial.items_seen).toBe(5);
      expect(partial.error_code).toBeTruthy();
      expect(partial.items_deactivated).toBe(0);
      expect(repository.activeCount()).toBe(FIXTURE_ITEMS);
      for (const skill of repository.skillRows.values()) {
        expect(skill.is_active).toBe(true);
      }
    });

    it('fonte devolve 5 de 25 sem falha de página: a guarda de 80% impede a desativação', async () => {
      const repository = new InMemoryCatalogRepository();
      const all = await fixtureItems();
      const five = all.slice(0, 5);

      await ingest({ source: createFixtureSource(), repository, adapter: 'fixture', startedAt: T1 });

      // 5 < 0,8 × 25 = 20: a guarda manda não desativar nada, faça o run o que fizer do status.
      // O status deste caso ficou em aberto no brief (ver relatório do tester): a tabela
      // ratificada diria `ok` (5/5 >= 0,5 e items_seen >= 1), o texto do brief pediu `partial`.
      const shrunk = await ingest({
        source: staticSource(five),
        repository,
        adapter: 'fixture',
        startedAt: T2,
      });

      expect(shrunk.items_seen).toBe(5);
      expect(shrunk.items_deactivated).toBe(0);
      expect(repository.activeCount()).toBe(FIXTURE_ITEMS);
      for (const skill of repository.skillRows.values()) {
        expect(skill.is_active).toBe(true);
      }
    });

    it('partial com items_seen acima da guarda de 80% ainda não desativa: só run ok desativa', async () => {
      const repository = new InMemoryCatalogRepository();
      const all = await fixtureItems();
      const five = all.slice(0, 5);
      const four = all.slice(0, 4);

      await ingest({ source: staticSource(five), repository, adapter: 'fixture', startedAt: T1 });
      expect(repository.activeCount()).toBe(5);

      // 4 >= 0,8 × 5 = 4: a guarda de tamanho autorizaria desativar. O que impede é o status
      // `partial` — é este caso que separa a regra "desativa só em ok" da guarda de 80%.
      const partial = await ingest({
        source: firstPageThenThrow(four, new Error('timeout na página 2')),
        repository,
        adapter: 'fixture',
        startedAt: T2,
      });

      expect(partial.status).toBe('partial');
      expect(partial.items_seen).toBe(4);
      expect(partial.items_deactivated).toBe(0);
      expect(repository.activeCount()).toBe(5);
      for (const skill of repository.skillRows.values()) {
        expect(skill.is_active).toBe(true);
      }
    });

    it('fonte devolve 0 itens: partial com error_code e catálogo preservado', async () => {
      const repository = new InMemoryCatalogRepository();
      await ingest({ source: createFixtureSource(), repository, adapter: 'fixture', startedAt: T1 });

      const empty = await ingest({
        source: staticSource([]),
        repository,
        adapter: 'fixture',
        startedAt: T2,
      });

      expect(empty.status).toBe('partial');
      expect(empty.items_seen).toBe(0);
      expect(empty.items_upserted).toBe(0);
      expect(empty.error_code).toBeTruthy();
      expect(repository.activeCount()).toBe(FIXTURE_ITEMS);

      const run = lastRun(repository);
      expect(run.status).toBe('partial');
      expect(run.error_code).toBeTruthy();
      expect(run.finished_at).toBeInstanceOf(Date);
    });

    /**
     * Teto de páginas (§7.3, `MAX_PAGES`): a fonte sempre tem "mais uma". O run
     * para no teto e sai `partial` / `PAGE_LIMIT_REACHED` — nunca `ok`, porque
     * ninguém sabe o que ficou de fora, e nunca desativa (a guarda de 80% é do
     * caminho `ok`).
     */
    it('fonte que nunca esgota bate o teto de páginas: partial/PAGE_LIMIT_REACHED', async () => {
      const repository = new InMemoryCatalogRepository();

      const result = await ingest({
        source: endlessSource(),
        repository,
        adapter: 'fixture',
        startedAt: T1,
      });

      expect(result.status).toBe('partial');
      expect(result.error_code).toBe(INGEST_ERROR_CODES.pageLimitReached);
      // Uma chave inédita por página: o teto é de páginas, e `items_seen` reflete
      // exatamente o que foi lido até ele.
      expect(result.items_seen).toBe(MAX_PAGES);
      expect(result.items_upserted).toBe(MAX_PAGES);
      expect(result.items_deactivated).toBe(0);
      expect(repository.activeCount()).toBe(MAX_PAGES);

      const run = lastRun(repository);
      expect(run.status).toBe('partial');
      expect(run.error_code).toBe(INGEST_ERROR_CODES.pageLimitReached);
      expect(run.items_seen).toBe(MAX_PAGES);
    });

    /**
     * `upserted/seen < 0,5`: a fonte viu 25 itens e o banco só registrou 5. Metade
     * do catálogo lido não chegou ao banco — `partial`, com o motivo explícito, e
     * sem desativar ninguém (o caminho `ok` nem foi alcançado).
     */
    it('repositório que grava menos da metade dos itens: partial/LOW_UPSERT_RATIO', async () => {
      const repository = new LowRatioRepository();

      const result = await ingest({
        source: createFixtureSource(),
        repository,
        adapter: 'fixture',
        startedAt: T1,
      });

      expect(result.status).toBe('partial');
      expect(result.error_code).toBe(INGEST_ERROR_CODES.lowUpsertRatio);
      expect(result.items_seen).toBe(FIXTURE_ITEMS);
      expect(result.items_upserted).toBe(5);
      expect(result.items_deactivated).toBe(0);
      expect(repository.activeCount()).toBe(5);
    });
  });

  describe('run órfão', () => {
    it('run running de 3 h atrás vira STALE_RUN antes do run novo', async () => {
      const repository = new InMemoryCatalogRepository();
      const staleId = await repository.startRun({
        adapter: 'fixture',
        started_at: new Date(T3.getTime() - 3 * HOUR_MS),
      });

      const result = await ingest({
        source: createFixtureSource(),
        repository,
        adapter: 'fixture',
        startedAt: T3,
      });

      expect(result.status).toBe('ok');

      const stale = repository.runRows.find((run) => run.id === staleId);
      expect(stale?.status).toBe('failed');
      expect(stale?.error_code).toBe('STALE_RUN');

      const fresh = lastRun(repository);
      expect(fresh.id).not.toBe(staleId);
      expect(fresh.status).toBe('ok');
      expect(fresh.started_at).toEqual(T3);
    });
  });

  describe('nenhum socket', () => {
    /**
     * A contagem é lida **antes** do `mockRestore()`: `mockRestore` zera `mock.calls`, então
     * `expect(connect).not.toHaveBeenCalled()` depois dele passaria por construção, mesmo com a
     * ingestão abrindo socket. A validade do mecanismo foi conferida com controle positivo (uma
     * conexão loopback deliberada é contada) antes de o teste entrar no repositório.
     */
    it('ingerir a fixture não abre conexão de rede (regra 5 do AGENTS.md)', async () => {
      const repository = new InMemoryCatalogRepository();
      const socketPrototype = net.Socket.prototype as unknown as {
        connect: (...args: unknown[]) => unknown;
      };
      const connect = jest.spyOn(socketPrototype, 'connect');
      let connectCalls = -1;

      try {
        await ingest({ source: createFixtureSource(), repository, adapter: 'fixture', startedAt: T1 });
        connectCalls = connect.mock.calls.length;
      } finally {
        connect.mockRestore();
      }

      expect(connectCalls).toBe(0);
      expect(repository.skillRows.size).toBe(FIXTURE_ITEMS);
    });
  });
});
