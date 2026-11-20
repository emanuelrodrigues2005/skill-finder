/**
 * Issue #46 — a ingestão por **rodízio** (`docs/app/02-arquitetura.md` §7.3).
 *
 * O que muda em relação à ingestão paginada: a unidade de aquisição é a
 * **chave**, não a página. Cada execução pede as chaves do ciclo
 * (`selectRotationKeys`, até 720), busca exatamente essas (`fetchSkills(keys)`) e
 * faz upsert. `items_requested` é o tamanho do ciclo, e é **contra ele** — não
 * contra os 20.000 ativos — que se medem a razão de upsert e a guarda de 80%:
 * 720 de 20.000 é 3,6% de cobertura e é o rodízio funcionando, não uma falha.
 *
 * Tabela ratificada (`running -> ok | partial | failed`):
 *
 *   | condição                                          | status                     |
 *   | fonte lança antes de gravar / repositório lança    | failed                     |
 *   | nenhuma chave no ciclo e a fonte não enumera      | partial/EMPTY_CATALOG      |
 *   | o ciclo viu < 80% das chaves pedidas              | partial/LOW_CYCLE_COVERAGE |
 *   | gravou < 50% das chaves pedidas                   | partial/LOW_UPSERT_RATIO   |
 *   | caso contrário                                    | ok                         |
 *
 * **Desativação só por idade** (`deactivateSkillsStaleBefore(startedAt - 28 d)`),
 * nunca por "não visto neste ciclo": a guarda de 80% decide o *status*, não o
 * `is_active`. As duas coisas medem unidades diferentes e por isso são caminhos
 * separados.
 *
 * Sem banco, sem docker, sem rede: o repositório é **em memória** (abaixo) e a
 * fonte é a fixture congelada ou um duplo que responde só as chaves pedidas.
 */
import * as net from 'node:net';

import type {
  CatalogRepository,
  IngestRunFinish,
  IngestRunRow,
  RotationBands,
  RotationParams,
} from '@/catalog/catalog-repository';
import { INGEST_ERROR_CODES } from '@/catalog/catalog-repository';
import { createFixtureSource } from '@/catalog/fixture-source';
import {
  COLD_MAX_DAYS,
  COLD_MIN_DAYS,
  CYCLE_SLOTS,
  DEACTIVATION_TTL_DAYS,
  HOT_SLOTS,
  ingest,
  MIN_CYCLE_COVERAGE,
  MIN_UPSERT_RATIO,
  planCycle,
  type CycleBudget,
} from '@/catalog/ingest';
import type { SkillRecord, SkillSource } from '@/catalog/skill-source';

/** Relógio fixo: o orquestrador nunca lê o relógio sozinho. */
const T1 = new Date('2026-11-15T00:00:00.000Z');
const T2 = new Date('2026-11-15T06:00:00.000Z');
const T3 = new Date('2026-11-15T12:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Tamanho da amostra congelada (25 skills reais de 2026-11-15). */
const FIXTURE_ITEMS = 25;

/** Ordem de grandeza do catálogo real: o rodízio nunca vê isto num ciclo. */
const BIG_CATALOG = 20_000;

function daysBefore(moment: Date, days: number): Date {
  return new Date(moment.getTime() - days * DAY_MS);
}

/** Linha de `skill` como o repositório em memória a guarda (campos da ingestão). */
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
 * - `selectRotationKeys` devolve as linhas **ativas em duas bandas**: as marcadas
 *   com `seedHot` vão para o hot (até `hotSlots`), o resto para o cold (até o que
 *   sobra do ciclo), na ordem em que foram semeadas — é o que o SQL de rodízio faz
 *   depois de ordenar cada banda;
 * - `selectUnseenKeys` devolve as candidatas que não são linha **ativa**, como o
 *   `SELECT ... WHERE is_active = true` do repositório de produção;
 * - `upsertSkills` chaveia por `source_key`, como `ON CONFLICT (source_key)`;
 * - `deactivateSkillsStaleBefore` desativa por `last_seen_at < cutoff`, como a
 *   statement única ratificada — nunca por lista de ids.
 */
class InMemoryCatalogRepository implements CatalogRepository {
  private readonly skills = new Map<string, StoredSkill>();
  private readonly hot = new Set<string>();
  private readonly runs: StoredRun[] = [];
  private nextRunId = 1;

  /** Chamadas de upsert, para provar que a 2ª execução regrava as mesmas linhas. */
  readonly upsertCalls: string[][] = [];
  /** Parâmetros com que o rodízio foi chamado — o relógio tem de vir daqui. */
  readonly rotationCalls: RotationParams[] = [];
  /** Chamadas de `selectUnseenKeys`, para provar que a descoberta perguntou. */
  readonly unseenCalls: string[][] = [];

  get skillRows(): ReadonlyMap<string, StoredSkill> {
    return this.skills;
  }

  get runRows(): readonly StoredRun[] {
    return this.runs;
  }

  activeCount(): number {
    return [...this.skills.values()].filter((skill) => skill.is_active).length;
  }

  /** Semeia uma linha já existente no catálogo (o estado "antes" do run). */
  seedSkill(key: string, lastSeenAt: Date, isActive = true): void {
    this.skills.set(key, {
      source_key: key,
      name: key.split('/').at(-1) ?? key,
      summary: null,
      installs: null,
      stars: null,
      vulnerability_count: null,
      source_url: null,
      repo_url: null,
      first_seen_at: lastSeenAt,
      last_seen_at: lastSeenAt,
      is_active: isActive,
    });
  }

  /** Marca a chave como quente: `search_request.result_ids` dos últimos 7 d. */
  seedHot(key: string): void {
    this.hot.add(key);
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

  selectRotationKeys(params: RotationParams): Promise<RotationBands> {
    this.rotationCalls.push(params);
    const active = [...this.skills.values()]
      .filter((skill) => skill.is_active)
      .map((skill) => skill.source_key);
    const hot = active.filter((key) => this.hot.has(key)).slice(0, Math.max(0, params.hotSlots));
    const hotChosen = new Set(hot);
    const cold = active
      .filter((key) => !hotChosen.has(key))
      .slice(0, Math.max(0, params.cycleSlots - hot.length));
    return Promise.resolve({ hot, cold });
  }

  selectUnseenKeys(candidates: readonly string[]): Promise<string[]> {
    const listed = [...new Set(candidates)];
    this.unseenCalls.push(listed);
    const active = new Set(
      [...this.skills.values()].filter((skill) => skill.is_active).map((skill) => skill.source_key),
    );
    return Promise.resolve(listed.filter((key) => !active.has(key)));
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
    return Promise.resolve(new Set(skills.map((skill) => skill.source_key)).size);
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

/**
 * Repositório cujo `upsertSkills` lança — banco fora do ar no meio do run. A
 * tabela do §7.3 é explícita: repositório que lança fecha o run como `failed`
 * com `REPOSITORY_FAILED`; o run **não** fica `running` esperando o
 * `failStaleRuns` de duas horas depois.
 */
class FailingUpsertRepository implements CatalogRepository {
  constructor(private readonly inner: InMemoryCatalogRepository) {}

  failStaleRuns(startedBefore: Date): Promise<number> {
    return this.inner.failStaleRuns(startedBefore);
  }

  startRun(run: {
    adapter: string;
    started_at: Date;
    items_requested?: number | null;
  }): Promise<number> {
    return this.inner.startRun(run);
  }

  finishRun(id: number, patch: IngestRunFinish): Promise<void> {
    return this.inner.finishRun(id, patch);
  }

  countActiveSkills(): Promise<number> {
    return this.inner.countActiveSkills();
  }

  selectRotationKeys(params: RotationParams): Promise<RotationBands> {
    return this.inner.selectRotationKeys(params);
  }

  selectUnseenKeys(candidates: readonly string[]): Promise<string[]> {
    return this.inner.selectUnseenKeys(candidates);
  }

  upsertSkills(): Promise<number> {
    return Promise.reject(new Error('upsert indisponível: conexão encerrada'));
  }

  deactivateSkillsStaleBefore(cutoff: Date): Promise<number> {
    return this.inner.deactivateSkillsStaleBefore(cutoff);
  }
}

/**
 * Repositório com o **seletor quebrado**: nenhuma chave no rodízio, catálogo
 * populado. A ingestão não pode inventar trabalho na fonte para encobrir o
 * defeito (`#46`, parecer do F1): a resposta é `items_requested: 0` e
 * `EMPTY_CATALOG`, sem enumerar a fonte.
 */
class EmptySelectorRepository extends InMemoryCatalogRepository {
  override selectRotationKeys(params: RotationParams): Promise<RotationBands> {
    this.rotationCalls.push(params);
    return Promise.resolve({ hot: [], cold: [] });
  }
}

/**
 * Fonte com espiões: `fetchSkills` e `listKeys` viram `jest.Mock` para que o
 * teste veja **se** a enumeração foi chamada e **quais** chaves foram pedidas —
 * as duas coisas que o parecer do `#46` exige provar (F1).
 */
function spySource(records: readonly SkillRecord[], listed?: readonly string[]) {
  const inner = keyedSource(records, listed);
  // Setas, não referências soltas: `jest.fn(inner.listKeys)` dispara
  // `@typescript-eslint/unbound-method` e separa o método do seu objeto.
  const listKeys = jest.fn(() => inner.listKeys());
  const fetchSkills = jest.fn((keys: readonly string[]) => inner.fetchSkills(keys));
  return { source: { ...inner, listKeys, fetchSkills } as SkillSource, listKeys, fetchSkills };
}

/** Repositório que grava só `kept` de cada lote: a razão de upsert despenca. */
class LowRatioRepository extends InMemoryCatalogRepository {
  constructor(private readonly kept: number) {
    super();
  }

  override upsertSkills(skills: SkillRecord[], seenAt: Date): Promise<number> {
    return super.upsertSkills(skills.slice(0, this.kept), seenAt);
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

/** `count` chaves no formato do catálogo real (`owner/repo/slug`). */
function catalogKeys(count: number, prefix = 'acme/toolbox'): string[] {
  return Array.from({ length: count }, (_unused, index) => `${prefix}/skill-${String(index)}`);
}

/**
 * Fonte que conhece estas skills e responde **exatamente** as chaves pedidas, na
 * ordem pedida — o contrato de `fetchSkills`. Chave desconhecida é ausência.
 */
function keyedSource(records: readonly SkillRecord[], listed?: readonly string[]): SkillSource {
  const byKey = new Map(records.map((item) => [item.source_key, item]));
  const known = listed ?? records.map((item) => item.source_key);
  return {
    capabilities: { supports_categories: false, supports_documents: false },
    listCategories: () => Promise.resolve([]),
    listKeys: () => Promise.resolve([...known]),
    fetchSkills: (keys: readonly string[]): Promise<SkillRecord[]> => {
      const answered: SkillRecord[] = [];
      for (const key of keys) {
        const found = byKey.get(key);
        if (found !== undefined) {
          answered.push(found);
        }
      }
      return Promise.resolve(answered);
    },
    fetchDocument: () => Promise.resolve(null),
  };
}

/** Fonte que lança antes de entregar qualquer item (site fora do ar, HTML quebrado). */
function throwingSource(error: Error): SkillSource {
  return {
    capabilities: { supports_categories: false, supports_documents: false },
    listCategories: () => Promise.resolve([]),
    listKeys: () => Promise.resolve([]),
    fetchSkills: () => Promise.reject(error),
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
    listKeys: () => Promise.resolve([]),
    fetchSkills: () => {
      // A regra existe para codigo de producao, onde um alvo sem `Error` perde
      // stack. Aqui a string E o vetor: o teste prova que a ingestao nao depende
      // de a fonte lancar um `Error` bem formado.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw text;
    },
    fetchDocument: () => Promise.resolve(null),
  };
}

/** Os 25 itens da fixture, lidos pelas chaves que a própria fonte enumera. */
async function fixtureItems(): Promise<SkillRecord[]> {
  const source = createFixtureSource();
  const items = await source.fetchSkills(await source.listKeys());
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

/** Semeia as `count` primeiras chaves como ativas, vistas há `seenDaysAgo`. */
function seedActive(
  repository: InMemoryCatalogRepository,
  keys: readonly string[],
  seenDaysAgo: number,
  now: Date = T1,
): void {
  for (const key of keys) {
    repository.seedSkill(key, daysBefore(now, seenDaysAgo));
  }
}

/** Orçamentos ratificados de um ciclo (D3), para os testes de `planCycle`. */
function budget(cycleSlots: number, hotSlots: number = HOT_SLOTS): CycleBudget {
  return { cycleSlots, hotSlots };
}

describe('catalog ingest — ciclo de rodízio (docs/app/02-arquitetura.md §7.3, #46)', () => {
  describe('parâmetros ratificados', () => {
    it('o ciclo pede 720 chaves, com hot de até 360 e frio entre 7 e 14 dias', () => {
      expect(CYCLE_SLOTS).toBe(720);
      expect(HOT_SLOTS).toBe(360);
      expect(COLD_MIN_DAYS).toBe(7);
      expect(COLD_MAX_DAYS).toBe(14);
      // O expurgo é por idade (28 d); nunca pela janela do ciclo.
      expect(DEACTIVATION_TTL_DAYS).toBe(28);
      expect(DEACTIVATION_TTL_DAYS).toBeGreaterThan(COLD_MAX_DAYS);
    });

    it('a seleção recebe o relógio do run, não `new Date()`', async () => {
      const repository = new InMemoryCatalogRepository();
      const keys = catalogKeys(3);
      seedActive(repository, keys, 10);

      await ingest({
        source: keyedSource(keys.map(record)),
        repository,
        adapter: 'fixture',
        startedAt: T2,
      });

      const params = repository.rotationCalls[0];
      expect(params?.now).toEqual(T2);
      expect(params?.cycleSlots).toBe(CYCLE_SLOTS);
      expect(params?.hotSlots).toBe(HOT_SLOTS);
      expect(params?.coldMinDays).toBe(COLD_MIN_DAYS);
      expect(params?.coldMaxDays).toBe(COLD_MAX_DAYS);
    });
  });

  describe('rodízio de 720 num catálogo de 20.000', () => {
    it('vê 720 de 20.000 ativos e fecha ok — 3,6% de cobertura é o rodízio, não falha', async () => {
      const repository = new InMemoryCatalogRepository();
      const keys = catalogKeys(BIG_CATALOG);
      seedActive(repository, keys, 10);

      const outcome = await ingest({
        source: keyedSource(keys.slice(0, CYCLE_SLOTS).map(record), keys),
        repository,
        adapter: 'html',
        startedAt: T2,
      });

      expect(outcome.status).toBe('ok');
      expect(outcome.error_code).toBeNull();
      // O número é o do ciclo, não o do catálogo: a asserção existe para falhar
      // caso alguém volte a contar o catálogo inteiro.
      expect(outcome.items_seen).toBe(CYCLE_SLOTS);
      expect(outcome.items_seen).not.toBe(BIG_CATALOG);
      expect(outcome.items_upserted).toBe(CYCLE_SLOTS);
      expect(outcome.items_requested).toBe(CYCLE_SLOTS);
      // Nada foi desativado: o rodízio não julga `is_active` por não-visita.
      expect(outcome.items_deactivated).toBe(0);
      expect(repository.activeCount()).toBe(BIG_CATALOG);

      const run = lastRun(repository);
      expect(run.status).toBe('ok');
      expect(run.items_requested).toBe(CYCLE_SLOTS);
      expect(run.items_seen).toBe(CYCLE_SLOTS);
    });

    it('nunca pede mais chaves do que o teto do ciclo, mesmo com catálogo maior', async () => {
      const repository = new InMemoryCatalogRepository();
      const keys = catalogKeys(BIG_CATALOG);
      seedActive(repository, keys, 10);

      const outcome = await ingest({
        source: keyedSource(keys.map(record), keys),
        repository,
        adapter: 'html',
        startedAt: T2,
      });

      expect(outcome.items_requested).toBe(CYCLE_SLOTS);
      expect(outcome.items_seen).toBeLessThanOrEqual(CYCLE_SLOTS);
      // O primeiro lote de upsert é o do ciclo: a fonte não foi varrida inteira.
      expect(repository.upsertCalls[0]).toHaveLength(CYCLE_SLOTS);
    });
  });

  describe('idempotência', () => {
    it('duas execuções da mesma fixture: 25 itens, 25 linhas, sem duplicata', async () => {
      const repository = new InMemoryCatalogRepository();
      const items = await fixtureItems();
      const keys = items.map((item) => item.source_key);
      seedActive(repository, keys, 10, T2);

      const source = createFixtureSource();
      const first = await ingest({ source, repository, adapter: 'fixture', startedAt: T2 });
      expect(first.status).toBe('ok');
      expect(first.items_seen).toBe(FIXTURE_ITEMS);
      expect(first.items_upserted).toBe(FIXTURE_ITEMS);
      expect(first.items_requested).toBe(FIXTURE_ITEMS);
      expect(repository.skillRows.size).toBe(FIXTURE_ITEMS);

      const second = await ingest({ source, repository, adapter: 'fixture', startedAt: T3 });
      expect(second.status).toBe('ok');
      expect(second.items_seen).toBe(FIXTURE_ITEMS);
      expect(second.items_upserted).toBe(FIXTURE_ITEMS);
      expect(second.items_deactivated).toBe(0);

      // A segunda execução regravou os mesmos 25 — e o catálogo continua com 25.
      expect(repository.upsertCalls).toHaveLength(2);
      expect(repository.upsertCalls[1]).toHaveLength(FIXTURE_ITEMS);
      expect(new Set(repository.upsertCalls[1]).size).toBe(FIXTURE_ITEMS);
      expect(repository.skillRows.size).toBe(FIXTURE_ITEMS);
    });

    it('a segunda execução atualiza last_seen_at e mantém tudo ativo', async () => {
      const repository = new InMemoryCatalogRepository();
      const items = await fixtureItems();
      seedActive(
        repository,
        items.map((item) => item.source_key),
        10,
        T2,
      );
      const source = createFixtureSource();

      await ingest({ source, repository, adapter: 'fixture', startedAt: T2 });
      await ingest({ source, repository, adapter: 'fixture', startedAt: T3 });

      expect(repository.activeCount()).toBe(FIXTURE_ITEMS);
      for (const skill of repository.skillRows.values()) {
        expect(skill.last_seen_at).toEqual(T3);
        expect(skill.is_active).toBe(true);
      }
    });

    it('as duas execuções fecham com started_at e finished_at preenchidos', async () => {
      const repository = new InMemoryCatalogRepository();
      const items = await fixtureItems();
      seedActive(
        repository,
        items.map((item) => item.source_key),
        10,
        T2,
      );
      const source = createFixtureSource();

      const first = await ingest({ source, repository, adapter: 'fixture', startedAt: T2 });
      const second = await ingest({ source, repository, adapter: 'fixture', startedAt: T3 });

      expect(first.started_at).toEqual(T2);
      expect(first.finished_at).toBeInstanceOf(Date);
      expect(second.started_at).toEqual(T3);
      expect(second.finished_at.getTime()).toBeGreaterThanOrEqual(T3.getTime());

      const rows = repository.runRows;
      expect(rows).toHaveLength(2);
      expect(rows[0].adapter).toBe('fixture');
      expect(rows[0].status).toBe('ok');
      expect(rows[0].items_seen).toBe(FIXTURE_ITEMS);
      expect(rows[1].status).toBe('ok');
    });
  });

  describe('bootstrap do catálogo vazio', () => {
    /**
     * Sem esta saída o rodízio nunca começa: catálogo vazio ⇒
     * `selectRotationKeys` devolve `[]` ⇒ não haveria chave nenhuma para pedir.
     * A fonte enumera as chaves (sitemap, na `html`; a amostra, na `fixture`) e
     * o primeiro ciclo pede até o teto.
     */
    it('catálogo vazio: pede as chaves à fonte e ingere até o teto do ciclo', async () => {
      const repository = new InMemoryCatalogRepository();
      expect(repository.activeCount()).toBe(0);

      const outcome = await ingest({
        source: createFixtureSource(),
        repository,
        adapter: 'fixture',
        startedAt: T1,
      });

      expect(outcome.status).toBe('ok');
      expect(outcome.items_requested).toBe(FIXTURE_ITEMS);
      expect(outcome.items_seen).toBe(FIXTURE_ITEMS);
      expect(outcome.items_upserted).toBe(FIXTURE_ITEMS);
      expect(repository.activeCount()).toBe(FIXTURE_ITEMS);
    });

    it('seletor vazio com catálogo populado: EMPTY_CATALOG e a fonte não é enumerada', async () => {
      const repository = new EmptySelectorRepository();
      repository.seedSkill('acme/toolbox/uma', daysBefore(T2, 1));
      const { source, listKeys } = spySource([], ['acme/toolbox/uma']);

      const outcome = await ingest({ source, repository, adapter: 'html', startedAt: T2 });

      // `rotated === []` com `countActiveSkills() > 0` é defeito do seletor, não
      // catálogo vazio: a fonte não é consultada e o run registra o zero.
      expect(outcome.items_requested).toBe(0);
      expect(outcome.status).toBe('partial');
      expect(outcome.error_code).toBe(INGEST_ERROR_CODES.emptyCatalog);
      expect(listKeys).not.toHaveBeenCalled();

      const run = lastRun(repository);
      expect(run.items_requested).toBe(0);
      expect(run.error_code).toBe(INGEST_ERROR_CODES.emptyCatalog);
    });

    /**
     * O bootstrap acontece **antes** de `startRun`: se a enumeração da fonte
     * lançar (sitemap fora do ar), o run tem de mesmo assim existir em
     * `ingest_run` como `failed`, senão a falha não deixa rastro nenhum.
     */
    it('bootstrap com listKeys lançando: run failed/SOURCE_FETCH_FAILED fica registrado', async () => {
      const repository = new InMemoryCatalogRepository();
      const source: SkillSource = {
        ...keyedSource([]),
        listKeys: () => Promise.reject(new Error('sitemap.xml respondeu 503')),
      };

      const outcome = await ingest({ source, repository, adapter: 'html', startedAt: T2 });

      expect(outcome.status).toBe('failed');
      expect(outcome.error_code).toBe(INGEST_ERROR_CODES.sourceFetchFailed);
      expect(outcome.error_detail).toContain('503');
      expect(outcome.items_requested).toBe(0);

      expect(repository.runRows).toHaveLength(1);
      const run = lastRun(repository);
      expect(run.status).toBe('failed');
      expect(run.error_code).toBe(INGEST_ERROR_CODES.sourceFetchFailed);
      expect(run.items_requested).toBe(0);
      expect(run.items_seen).toBe(0);
      expect(run.finished_at).toBeInstanceOf(Date);
    });

    it('catálogo vazio e fonte sem chaves: partial/EMPTY_CATALOG, nada gravado', async () => {
      const repository = new InMemoryCatalogRepository();

      const outcome = await ingest({
        source: keyedSource([]),
        repository,
        adapter: 'fixture',
        startedAt: T1,
      });

      expect(outcome.status).toBe('partial');
      expect(outcome.error_code).toBe(INGEST_ERROR_CODES.emptyCatalog);
      expect(outcome.items_requested).toBe(0);
      expect(outcome.items_seen).toBe(0);
      expect(outcome.items_upserted).toBe(0);
      expect(outcome.items_deactivated).toBe(0);
      expect(repository.runRows.length).toBe(1);
    });
  });

  /**
   * F1 do parecer da #46 — **descoberta contínua**. O universo do rodízio é o
   * conjunto de chaves da fonte, não o conjunto de linhas do banco: a cada ciclo
   * as chaves que o rodízio ainda não conhece entram nos slots que sobraram.
   * Sem isso o catálogo fica travado nas primeiras 720 e os outros milhares que
   * o `sitemap.xml` publica nunca são buscados.
   */
  describe('descoberta contínua de chaves (F1 do parecer)', () => {
    /**
     * **Regressão do F1** — o caso do banco "cheio": quando o rodízio já ocupa
     * os 720 slots, a descoberta não pode ser faminta. A cota de descoberta é
     * reservada **antes** do cold, então as chaves que a fonte publica e o banco
     * não conhece entram no ciclo mesmo com o rodízio lotado. Sem isso o
     * catálogo trava nas primeiras 720 linhas para sempre.
     */
    it('catálogo com 720 linhas e fonte com 1.000 chaves: o ciclo inclui as 280 inéditas', async () => {
      const repository = new InMemoryCatalogRepository();
      seedActive(repository, catalogKeys(CYCLE_SLOTS), 1, T2);
      const sourceKeys = catalogKeys(1000);
      const unseenKeys = sourceKeys.slice(CYCLE_SLOTS);
      const { source, fetchSkills, listKeys } = spySource(sourceKeys.map(record), sourceKeys);

      const outcome = await ingest({ source, repository, adapter: 'html', startedAt: T2 });

      // A fonte **é** enumerada mesmo com o rodízio ocupando o ciclo inteiro.
      expect(listKeys).toHaveBeenCalledTimes(1);
      expect(outcome.items_requested).toBe(CYCLE_SLOTS);
      expect(outcome.status).toBe('ok');

      const asked = fetchSkills.mock.calls[0]?.[0] ?? [];
      expect(asked).toHaveLength(CYCLE_SLOTS);
      // A prova: as 280 chaves que o banco não tem entraram no ciclo.
      for (const key of unseenKeys) {
        expect(asked).toContain(key);
      }
    });

    it('catálogo com 25 linhas e fonte com 100 chaves: o ciclo inclui as 75 nunca vistas', async () => {
      const repository = new InMemoryCatalogRepository();
      const seeded = catalogKeys(25);
      seedActive(repository, seeded, 1, T2);
      const sourceKeys = catalogKeys(100);
      const { source, fetchSkills, listKeys } = spySource(sourceKeys.map(record), sourceKeys);

      const outcome = await ingest({ source, repository, adapter: 'html', startedAt: T2 });

      // 75 inéditas + 25 do rodízio: o ciclo é a união, cortada no teto.
      expect(outcome.items_requested).toBe(100);
      expect(outcome.items_seen).toBe(100);
      expect(outcome.status).toBe('ok');
      expect(listKeys).toHaveBeenCalledTimes(1);

      const asked = fetchSkills.mock.calls[0]?.[0] ?? [];
      expect(asked).toHaveLength(100);
      // As inéditas vêm em ordem determinística de code units (COLLATE "C"),
      // nunca na ordem do `Set` do sitemap — e antes do cold.
      const unseenSorted = sourceKeys.slice(25).sort((left, right) => (left < right ? -1 : 1));
      expect(asked.slice(0, 75)).toEqual(unseenSorted);
      expect(asked.slice(75)).toEqual(seeded);
    });

    /**
     * A regra que substituiu o antigo "orçamento cheio ⇒ não enumera": o hot
     * saturado **não** engole a cota de descoberta, porque ela é reservada antes
     * do cold. Com 360 hot + 720 conhecidas, sobram 360 slots para inéditas.
     */
    it('hot saturado (360) com catálogo de 720: a cota de descoberta reservada ainda traz inéditas', async () => {
      const repository = new InMemoryCatalogRepository();
      const known = catalogKeys(CYCLE_SLOTS);
      seedActive(repository, known, 1, T2);
      const hotKeys = known.slice(0, HOT_SLOTS);
      for (const key of hotKeys) {
        repository.seedHot(key);
      }
      const sourceKeys = catalogKeys(1000);
      const unseenKeys = sourceKeys.slice(CYCLE_SLOTS);
      const { source, fetchSkills, listKeys } = spySource(sourceKeys.map(record), sourceKeys);

      const outcome = await ingest({ source, repository, adapter: 'html', startedAt: T2 });

      expect(listKeys).toHaveBeenCalledTimes(1);
      expect(outcome.items_requested).toBe(CYCLE_SLOTS);
      expect(outcome.status).toBe('ok');

      const asked = fetchSkills.mock.calls[0]?.[0] ?? [];
      // Hot nunca faminto: os 360 slots quentes vêm primeiro, na ordem do repositório.
      expect(asked.slice(0, HOT_SLOTS)).toEqual(hotKeys);
      for (const key of unseenKeys) {
        expect(asked).toContain(key);
      }
    });

    it('chave inédita já no rodízio não é pedida duas vezes', async () => {
      const repository = new InMemoryCatalogRepository();
      const seeded = catalogKeys(3);
      seedActive(repository, seeded, 1, T2);
      // A fonte enumera as mesmas 3 do rodízio mais 2 inéditas: o ciclo soma 5,
      // sem repetir nenhuma (o `fetchSkills` recebe chaves distintas).
      const sourceKeys = [...seeded, 'acme/toolbox/nova-a', 'acme/toolbox/nova-b'];
      const { source, fetchSkills } = spySource(sourceKeys.map(record), sourceKeys);

      const outcome = await ingest({ source, repository, adapter: 'html', startedAt: T2 });

      expect(outcome.items_requested).toBe(5);
      const asked = fetchSkills.mock.calls[0]?.[0] ?? [];
      expect(new Set(asked).size).toBe(asked.length);
      // Sem hot, a cota de descoberta vem antes do cold: inéditas e depois as 3.
      expect(asked).toEqual(['acme/toolbox/nova-a', 'acme/toolbox/nova-b', ...seeded]);
    });

    /**
     * A prioridade em si, sem I/O: `planCycle` é pura, então a ordem e o corte
     * do ciclo são provados aqui — o `ingest` só faz as leituras.
     */
    describe('planCycle — a prioridade hot → inéditas → cold', () => {
      it('põe o hot primeiro, as inéditas ordenadas depois, e deixa o cold para o fim', () => {
        const keys = planCycle(
          {
            hot: ['quente-b', 'quente-a'],
            cold: ['fria-a'],
            unseen: ['nova-b', 'nova-a', 'fria-a'],
          },
          budget(6),
        );

        // 'fria-a' apareceu como inédita: entra na cota de descoberta, uma vez.
        expect(keys).toEqual(['quente-b', 'quente-a', 'fria-a', 'nova-a', 'nova-b']);
      });

      it('corta o ciclo no teto: o que não coube fica para o próximo', () => {
        expect(planCycle({ hot: ['b', 'a'], cold: [], unseen: ['d', 'c'] }, budget(3))).toEqual([
          'b',
          'a',
          'c',
        ]);
      });

      it('hot acima do teto (entrada hostil) não come a cota de descoberta', () => {
        expect(planCycle({ hot: ['x', 'y', 'z'], cold: [], unseen: ['w'] }, budget(5, 2))).toEqual([
          'x',
          'y',
          'w',
        ]);
      });

      it('não repete chave entre as três bandas', () => {
        expect(
          planCycle({ hot: ['a', 'a'], cold: ['a', 'b'], unseen: ['b', 'b'] }, budget(5)),
        ).toEqual(['a', 'b']);
      });

      it('ciclo sem slot nenhum devolve lista vazia', () => {
        expect(planCycle({ hot: ['a'], cold: ['b'], unseen: ['c'] }, budget(0, 0))).toEqual([]);
      });

      it('inéditas esgotadas: o ciclo é hot + cold, sem chave nova', () => {
        expect(
          planCycle(
            { hot: ['quente'], cold: ['fria-b', 'fria-a'], unseen: [] },
            budget(CYCLE_SLOTS),
          ),
        ).toEqual(['quente', 'fria-b', 'fria-a']);
      });
    });

    /**
     * A aritmética do backfill, que é o que a D3 promete: com a cota de
     * descoberta reservada, o catálogo alcança a fonte inteira em ciclos
     * contados — nenhuma chave fica eternamente fora.
     */
    it('backfill fecha: 25 conhecidas + 100 na fonte, ciclo de 50, em 3 ciclos as 100 são alcançadas', () => {
      const sourceKeys = catalogKeys(100);
      let known = sourceKeys.slice(0, 25);
      const seen = new Set<string>();

      for (let cycle = 1; cycle <= 3; cycle += 1) {
        const knownSet = new Set(known);
        const keys = planCycle(
          {
            hot: [],
            cold: known,
            unseen: sourceKeys.filter((key) => !knownSet.has(key)),
          },
          budget(50),
        );

        expect(keys.length).toBeLessThanOrEqual(50);
        for (const key of keys) {
          seen.add(key);
        }
        // O que o ciclo buscou passa a ser conhecido no ciclo seguinte.
        known = [...new Set([...known, ...keys])];
      }

      expect(seen.size).toBe(100);
    });

    it('inéditas esgotadas: o ciclo é hot + cold, e a pergunta ao banco é feita', async () => {
      const repository = new InMemoryCatalogRepository();
      const hotKeys = ['acme/toolbox/quente-a', 'acme/toolbox/quente-b'];
      const coldKeys = ['acme/toolbox/fria-a', 'acme/toolbox/fria-b', 'acme/toolbox/fria-c'];
      seedActive(repository, [...hotKeys, ...coldKeys], 10, T2);
      for (const key of hotKeys) {
        repository.seedHot(key);
      }
      const sourceKeys = [...hotKeys, ...coldKeys];
      const { source, fetchSkills, listKeys } = spySource(sourceKeys.map(record), sourceKeys);

      const outcome = await ingest({ source, repository, adapter: 'html', startedAt: T2 });

      expect(listKeys).toHaveBeenCalledTimes(1);
      // A descoberta perguntou ao banco quais das enumeradas são inéditas.
      expect(repository.unseenCalls).toHaveLength(1);
      const asked = fetchSkills.mock.calls[0]?.[0] ?? [];
      expect(asked).toEqual([...hotKeys, ...coldKeys]);
      expect(outcome.items_requested).toBe(5);
      expect(outcome.status).toBe('ok');
    });
  });

  describe('guarda de 80% do ciclo', () => {
    it('o ciclo viu 6 de 10 chaves pedidas: partial/LOW_CYCLE_COVERAGE', async () => {
      const repository = new InMemoryCatalogRepository();
      const keys = catalogKeys(10);
      seedActive(repository, keys, 1, T2);

      // Quatro chaves sumiram da fonte: o ciclo pediu 10 e só 6 responderam.
      const source = keyedSource(keys.slice(0, 6).map(record), keys);
      const outcome = await ingest({ source, repository, adapter: 'html', startedAt: T2 });

      expect(outcome.items_requested).toBe(10);
      expect(outcome.items_seen).toBe(6);
      expect(MIN_CYCLE_COVERAGE).toBe(0.8);
      expect(outcome.status).toBe('partial');
      expect(outcome.error_code).toBe(INGEST_ERROR_CODES.lowCycleCoverage);
      // "sem desativar": o que o ciclo não viu continua ativo (só a idade desativa).
      expect(outcome.items_deactivated).toBe(0);
      expect(repository.activeCount()).toBe(10);
      for (const skill of repository.skillRows.values()) {
        expect(skill.is_active).toBe(true);
      }
    });

    it('8 de 10 chaves é exatamente a guarda: o run fecha ok', async () => {
      const repository = new InMemoryCatalogRepository();
      const keys = catalogKeys(10);
      seedActive(repository, keys, 1, T2);

      const outcome = await ingest({
        source: keyedSource(keys.slice(0, 8).map(record), keys),
        repository,
        adapter: 'html',
        startedAt: T2,
      });

      expect(outcome.items_seen).toBe(8);
      expect(outcome.status).toBe('ok');
      expect(outcome.error_code).toBeNull();
    });

    it('7 de 10 (70%) já é partial: a guarda não é arredondada para cima', async () => {
      const repository = new InMemoryCatalogRepository();
      const keys = catalogKeys(10);
      seedActive(repository, keys, 1, T2);

      const outcome = await ingest({
        source: keyedSource(keys.slice(0, 7).map(record), keys),
        repository,
        adapter: 'html',
        startedAt: T2,
      });

      expect(outcome.status).toBe('partial');
      expect(outcome.error_code).toBe(INGEST_ERROR_CODES.lowCycleCoverage);
    });

    /**
     * F2 do parecer: `requested > 0` com `itemsSeen === 0` **sem erro da fonte**
     * é cobertura zero do ciclo (`LOW_CYCLE_COVERAGE`), não catálogo vazio — e,
     * como a fonte devolveu zero, o expurgo por idade não pode rodar: uma fonte
     * quebrada não pode auto-desativar o catálogo.
     */
    it('pediu 4, viu 0 e a fonte não lançou: partial/LOW_CYCLE_COVERAGE e sem expurgo', async () => {
      const repository = new InMemoryCatalogRepository();
      const keys = catalogKeys(3);
      seedActive(repository, keys, 1, T2);
      repository.seedSkill('acme/toolbox/vencida', daysBefore(T2, DEACTIVATION_TTL_DAYS + 1));

      const outcome = await ingest({
        source: keyedSource([], [...keys, 'acme/toolbox/vencida']),
        repository,
        adapter: 'html',
        startedAt: T2,
      });

      expect(outcome.items_requested).toBe(4);
      expect(outcome.items_seen).toBe(0);
      expect(outcome.status).toBe('partial');
      expect(outcome.error_code).toBe(INGEST_ERROR_CODES.lowCycleCoverage);
      // `itemsSeen === 0`: o expurgo fica para a próxima execução.
      expect(outcome.items_deactivated).toBe(0);
      expect(repository.skillRows.get('acme/toolbox/vencida')?.is_active).toBe(true);
    });

    /**
     * F6 do parecer: a guarda usa **a mesma fração** de `MIN_CYCLE_COVERAGE`
     * (4/5), em aritmética inteira. 12 de 15 é 80% exato; em ponto flutuante,
     * `0,8 × 15 = 12,000000000000002` e o run fecharia `partial` por engano.
     */
    it('12 de 15 (80% exato) fecha ok: a fração 4/5 não passa por float', async () => {
      const repository = new InMemoryCatalogRepository();
      const keys = catalogKeys(15);
      seedActive(repository, keys, 1, T2);

      const outcome = await ingest({
        source: keyedSource(keys.slice(0, 12).map(record), keys),
        repository,
        adapter: 'html',
        startedAt: T2,
      });

      expect(MIN_CYCLE_COVERAGE).toBe(4 / 5);
      expect(outcome.items_requested).toBe(15);
      expect(outcome.items_seen).toBe(12);
      expect(outcome.status).toBe('ok');
      expect(outcome.error_code).toBeNull();
    });
  });

  describe('razão de upsert contra items_requested', () => {
    it('pediu 10, viu 10, gravou 4: partial/LOW_UPSERT_RATIO', async () => {
      const repository = new LowRatioRepository(4);
      const keys = catalogKeys(10);
      seedActive(repository, keys, 1, T2);

      const outcome = await ingest({
        source: keyedSource(keys.map(record), keys),
        repository,
        adapter: 'html',
        startedAt: T2,
      });

      expect(MIN_UPSERT_RATIO).toBe(0.5);
      expect(outcome.items_requested).toBe(10);
      expect(outcome.items_seen).toBe(10);
      expect(outcome.items_upserted).toBe(4);
      expect(outcome.status).toBe('partial');
      expect(outcome.error_code).toBe(INGEST_ERROR_CODES.lowUpsertRatio);
      expect(outcome.items_deactivated).toBe(0);
    });
  });

  describe('desativação por idade (28 dias)', () => {
    /**
     * O caso que só o rodízio produz: o catálogo tem mais linhas do que o ciclo
     * alcança, então o vencido pode ficar **fora** do ciclo. Como ele não é
     * re-visto, o expurgo por idade é o único caminho que o desativa — e ele roda
     * mesmo com o run `ok`, porque mede idade, não cobertura.
     */
    it('run ok: o ciclo pede 720 de 721 e o expurgo desativa o vencido que ficou fora', async () => {
      const repository = new InMemoryCatalogRepository();
      const fresh = catalogKeys(CYCLE_SLOTS);
      seedActive(repository, fresh, 1, T2);
      // Inserido por último: `selectRotationKeys` corta em 720 e este fica fora.
      repository.seedSkill('acme/toolbox/vencida', daysBefore(T2, DEACTIVATION_TTL_DAYS + 1));

      const outcome = await ingest({
        source: keyedSource(fresh.map(record), fresh),
        repository,
        adapter: 'html',
        startedAt: T2,
      });

      expect(outcome.items_requested).toBe(CYCLE_SLOTS);
      expect(outcome.items_seen).toBe(CYCLE_SLOTS);
      expect(outcome.status).toBe('ok');
      expect(outcome.items_deactivated).toBe(1);
      expect(repository.skillRows.get('acme/toolbox/vencida')?.is_active).toBe(false);
      // O que o ciclo viu foi reativado/refrescado, não desativado.
      expect(repository.activeCount()).toBe(CYCLE_SLOTS);
    });

    it('a guarda de 80% não impede o expurgo por idade: são caminhos separados', async () => {
      const repository = new InMemoryCatalogRepository();
      const seen = ['acme/toolbox/vista-a', 'acme/toolbox/vista-b'];
      for (const key of seen) {
        repository.seedSkill(key, daysBefore(T2, 1));
      }
      repository.seedSkill('acme/toolbox/vencida', daysBefore(T2, DEACTIVATION_TTL_DAYS + 1));
      repository.seedSkill('acme/toolbox/na-borda', daysBefore(T2, DEACTIVATION_TTL_DAYS - 1));

      // O ciclo pede as 4 ativas e a fonte só conhece as 2 primeiras: cobertura
      // de 50%, abaixo da guarda — e ainda assim o expurgo por idade acontece.
      const outcome = await ingest({
        source: keyedSource(seen.map(record), seen),
        repository,
        adapter: 'html',
        startedAt: T2,
      });

      expect(outcome.items_requested).toBe(4);
      expect(outcome.items_seen).toBe(2);
      expect(outcome.status).toBe('partial');
      expect(outcome.error_code).toBe(INGEST_ERROR_CODES.lowCycleCoverage);
      expect(outcome.items_deactivated).toBe(1);
      expect(repository.skillRows.get('acme/toolbox/vencida')?.is_active).toBe(false);
      // 27 dias: dentro do TTL, o "não visto neste ciclo" não desativa.
      expect(repository.skillRows.get('acme/toolbox/na-borda')?.is_active).toBe(true);
      expect(repository.skillRows.get('acme/toolbox/vista-a')?.is_active).toBe(true);
      expect(repository.skillRows.get('acme/toolbox/vista-b')?.is_active).toBe(true);
    });

    it('run failed não desativa nem por idade', async () => {
      const repository = new InMemoryCatalogRepository();
      repository.seedSkill('acme/toolbox/vencida', daysBefore(T2, DEACTIVATION_TTL_DAYS + 1));

      const outcome = await ingest({
        source: throwingSource(new Error('skills.sh respondeu 503')),
        repository,
        adapter: 'html',
        startedAt: T2,
      });

      expect(outcome.status).toBe('failed');
      expect(outcome.items_deactivated).toBe(0);
      expect(repository.skillRows.get('acme/toolbox/vencida')?.is_active).toBe(true);
    });
  });

  describe('run failed', () => {
    it('fonte lança antes de entregar: failed/SOURCE_FETCH_FAILED e catálogo intacto', async () => {
      const repository = new InMemoryCatalogRepository();
      const keys = catalogKeys(3);
      seedActive(repository, keys, 5, T2);

      const failed = await ingest({
        source: throwingSource(new Error('skills.sh respondeu 503')),
        repository,
        adapter: 'html',
        startedAt: T2,
      });

      expect(failed.status).toBe('failed');
      expect(failed.error_code).toBe(INGEST_ERROR_CODES.sourceFetchFailed);
      expect(failed.error_detail).toContain('503');
      expect(failed.items_upserted).toBe(0);
      expect(failed.items_deactivated).toBe(0);
      expect(repository.activeCount()).toBe(3);

      const run = lastRun(repository);
      expect(run.status).toBe('failed');
      expect(run.finished_at).toBeInstanceOf(Date);
      // O run registra quantas chaves o ciclo pediu, mesmo tendo falhado.
      expect(run.items_requested).toBe(3);
    });

    it('repositório lançando no upsert fecha o run como failed/REPOSITORY_FAILED', async () => {
      const repository = new InMemoryCatalogRepository();
      const keys = catalogKeys(3);
      seedActive(repository, keys, 5, T2);

      const result = await ingest({
        source: keyedSource(keys.map(record), keys),
        repository: new FailingUpsertRepository(repository),
        adapter: 'html',
        startedAt: T2,
      });

      expect(result.status).toBe('failed');
      expect(result.error_code).toBe(INGEST_ERROR_CODES.repositoryFailed);
      expect(result.error_detail).toContain('upsert indisponível');
      expect(result.items_seen).toBe(3);
      expect(result.items_upserted).toBe(0);
      expect(result.items_deactivated).toBe(0);

      const run = lastRun(repository);
      expect(run.status).toBe('failed');
      expect(run.error_code).toBe(INGEST_ERROR_CODES.repositoryFailed);
      expect(run.started_at).toEqual(T2);
      expect(repository.activeCount()).toBe(3);
    });

    /**
     * `error_detail` tem teto de 500 caracteres (coluna e log). O começo do
     * texto, que é o que identifica a falha, tem de sobreviver ao corte.
     */
    it('mensagem de erro acima de 500 caracteres é truncada no error_detail', async () => {
      const repository = new InMemoryCatalogRepository();
      // Uma chave no ciclo: sem catálogo não há o que pedir à fonte, e o run
      // fecharia `partial/EMPTY_CATALOG` antes de a fonte lançar.
      repository.seedSkill('acme/toolbox/uma', daysBefore(T2, 1));

      const result = await ingest({
        source: throwingSource(new Error(`falha do driver: ${'x'.repeat(600)}`)),
        repository,
        adapter: 'html',
        startedAt: T2,
      });

      expect(result.status).toBe('failed');
      expect(result.error_detail).toHaveLength(500);
      expect(result.error_detail?.startsWith('falha do driver:')).toBe(true);
      expect(lastRun(repository).error_detail).toHaveLength(500);
      expect(lastRun(repository).error_code).toBe(INGEST_ERROR_CODES.sourceFetchFailed);
    });

    it('rejeição com texto (não Error) é registrada, sem virar [object Object]', async () => {
      const repository = new InMemoryCatalogRepository();
      repository.seedSkill('acme/toolbox/uma', daysBefore(T2, 1));

      const result = await ingest({
        source: rejectingWithTextSource('timeout de leitura do socket'),
        repository,
        adapter: 'html',
        startedAt: T2,
      });

      expect(result.status).toBe('failed');
      expect(result.error_code).toBe(INGEST_ERROR_CODES.sourceFetchFailed);
      expect(result.error_detail).toBe('timeout de leitura do socket');
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
     * A contagem é lida **antes** do `mockRestore()`: `mockRestore` zera
     * `mock.calls`, então `expect(connect).not.toHaveBeenCalled()` depois dele
     * passaria por construção, mesmo com a ingestão abrindo socket.
     */
    it('ingerir a fixture não abre conexão de rede (regra 5 do AGENTS.md)', async () => {
      const repository = new InMemoryCatalogRepository();
      const socketPrototype = net.Socket.prototype as unknown as {
        connect: (...args: unknown[]) => unknown;
      };
      const connect = jest.spyOn(socketPrototype, 'connect');
      let connectCalls = -1;

      try {
        await ingest({
          source: createFixtureSource(),
          repository,
          adapter: 'fixture',
          startedAt: T1,
        });
        connectCalls = connect.mock.calls.length;
      } finally {
        connect.mockRestore();
      }

      expect(connectCalls).toBe(0);
      expect(repository.skillRows.size).toBe(FIXTURE_ITEMS);
    });
  });
});
