/**
 * Issue #7 — o SQL do repositório Prisma do catálogo, provado **sem banco**.
 *
 * `prisma-catalog.repository.ts` monta duas statements de `$executeRaw` cujo texto nunca foi
 * exercitado pela suíte (nenhum teste abria Postgres, e abrir socket é proibido pela regra 5 do
 * `AGENTS.md`). O `coder` exportou `buildUpsertStatement` e `buildMetricSnapshotStatement`
 * justamente para que a montagem seja inspecionável: `Prisma.Sql` expõe `sql` (a string, com `?`
 * nos lugares dos parâmetros) e `values` (os parâmetros na ordem em que aparecem). O que este spec
 * prova é a **forma** da statement e a separação dado × string — não a semântica do Postgres.
 *
 * Dois contratos vêm de fora do código de produção:
 *
 * - **16 parâmetros por linha** do upsert e **uma linha por `source_key` distinta** (a última
 *   ocorrência do lote vence): repetir a mesma chave numa statement
 *   `ON CONFLICT DO UPDATE` faz o Postgres recusar o comando inteiro com
 *   `21000: cannot affect row a second time`, e como os lotes rodam numa transação só isso
 *   derrubaria o run.
 * - **`items_seen` e `items_upserted` contam a mesma unidade**: a razão `upserted / seen` (0,5, §7.3)
 *   só significa "quanto do que foi lido chegou ao banco" se os dois números contarem a mesma coisa.
 *   O texto ratificado diz "itens recebidos"; o dono decidiu **contar chaves distintas**, e é essa
 *   decisão que o bloco C fixa. Sem ela, uma página que repete a skill (destaque + listagem) empurra
 *   a razão para baixo e o run vira `partial` mesmo com tudo gravado.
 */
import type {
  CatalogRepository,
  IngestRunFinish,
  RotationParams,
} from '@/catalog/catalog-repository';
import { ingest } from '@/catalog/ingest';
import {
  buildMetricSnapshotStatement,
  buildUpsertStatement,
} from '@/catalog/prisma-catalog.repository';
import type { SkillRecord, SkillSource } from '@/catalog/skill-source';

/** Relógio fixo: `started_at` e `captured_at` são injetados, nunca lidos do relógio real. */
const CAPTURED_AT = new Date('2026-11-17T03:00:00.000Z');

/**
 * Parâmetros que uma linha do upsert consome: 16. São 13 das colunas (as que vão antes do literal
 * `true` de `is_active`), mais `raw`, mais os **dois** insumos do `to_tsvector` (`name` e `summary`
 * aparecem duas vezes cada no `VALUES`: uma como coluna, outra dentro do tsvector).
 */
const PARAMS_PER_ROW = 16;

/**
 * Uma skill completa, para que nenhum campo chegue `undefined` e a contagem de parâmetros seja a
 * de uma linha real. Os `overrides` mudam só o que o caso precisa.
 */
function skill(overrides: Partial<SkillRecord> = {}): SkillRecord {
  return {
    source_key: 'acme/toolbox/find-skills',
    source_url: 'https://skills.sh/acme/toolbox/find-skills',
    name: 'find-skills',
    summary: 'Finds skills for the current task',
    category_slug: 'discovery',
    stars: 128,
    installs: 42,
    vulnerability_count: null,
    security_status: 'unknown',
    repo_url: null,
    skill_md_present: true,
    first_seen_at: new Date('2026-11-01T00:00:00.000Z'),
    raw: { rank: 1 },
    ...overrides,
  };
}

/** Lote de três chaves distintas — o lote "normal" que a ingestão entrega ao repositório. */
function threeDistinctSkills(): SkillRecord[] {
  return [
    skill({ source_key: 'acme/toolbox/alpha', name: 'alpha', stars: 1 }),
    skill({ source_key: 'acme/toolbox/beta', name: 'beta', stars: 2 }),
    skill({ source_key: 'acme/toolbox/gamma', name: 'gamma', stars: 3 }),
  ];
}

/** Lista de colunas do `INSERT INTO "skill" (...)`, na ordem da statement. */
function insertColumns(sql: string): string[] {
  const match = /INSERT INTO "skill" \(([\s\S]*?)\)\s*VALUES/.exec(sql);
  if (match === null) {
    throw new Error('a statement do upsert não tem `INSERT INTO "skill" (...)` reconhecível');
  }
  return match[1]
    .split(',')
    .map((column) => column.trim())
    .filter((column) => column.length > 0);
}

/** Lista de colunas do bloco `ON CONFLICT (source_key) DO UPDATE SET`. */
function setColumns(sql: string): string[] {
  const parts = sql.split('ON CONFLICT (source_key) DO UPDATE SET');
  const tail = parts[1];
  if (tail === undefined) {
    throw new Error('a statement do upsert não tem `ON CONFLICT (source_key) DO UPDATE SET`');
  }
  return [...tail.matchAll(/^[ \t]*([a-z_]+)[ \t]*=/gm)].map((match) => match[1]);
}

describe('catalog SQL — upsert (bloco A: estrutura e parametrização)', () => {
  it('1. a statement é o upsert por source_key', () => {
    const statement = buildUpsertStatement(threeDistinctSkills(), CAPTURED_AT);

    expect(statement.sql).toContain('ON CONFLICT (source_key) DO UPDATE');
    expect(statement.sql).toContain('INSERT INTO "skill"');
    // Nada de `UPDATE`/`DELETE` solto: a única escrita é o upsert.
    expect(statement.sql.trim().startsWith('INSERT INTO "skill"')).toBe(true);
  });

  it('2. o SET cobre todas as colunas do INSERT e cada uma vem de EXCLUDED', () => {
    const statement = buildUpsertStatement(threeDistinctSkills(), CAPTURED_AT);
    const inserted = insertColumns(statement.sql);
    const updated = setColumns(statement.sql);

    // 16 colunas no INSERT (as do schema), 15 no SET: `source_key` é a chave do conflito.
    expect(inserted).toHaveLength(16);
    expect(updated).toHaveLength(15);
    expect([...updated].sort()).toEqual(
      inserted.filter((column) => column !== 'source_key').sort(),
    );

    // 13 colunas do SET recebem o valor de EXCLUDED diretamente...
    const direct = updated.filter((column) => column !== 'is_active' && column !== 'search_doc');
    expect(direct).toHaveLength(13);
    for (const column of direct) {
      expect(statement.sql).toMatch(new RegExp(`EXCLUDED\\.${column}\\b`));
    }

    // ...`is_active` é constante do run (visto agora = ativo), sem EXCLUDED...
    expect(statement.sql).toMatch(/is_active[ \t]*=[ \t]*true\b/);
    expect(statement.sql).not.toMatch(/EXCLUDED\.is_active/);

    // ...e `search_doc` é recomputado do EXCLUDED (o tsvector do lote), não copiado.
    expect(statement.sql).not.toMatch(/EXCLUDED\.search_doc/);
    expect(statement.sql).toMatch(/EXCLUDED\.name/);
    expect(statement.sql).toMatch(/EXCLUDED\.summary/);

    // 13 referências diretas + as duas do tsvector recomputado = 15 ocorrências de `EXCLUDED.`,
    // que é o número medido pelo `coder`.
    expect([...statement.sql.matchAll(/EXCLUDED\.\w+/g)]).toHaveLength(15);

    // `first_seen_at` preserva a aparição mais antiga (LEAST), não a sobrescreve.
    expect(statement.sql).toMatch(
      /first_seen_at[ \t]*=[ \t]*LEAST\("skill"\.first_seen_at, EXCLUDED\.first_seen_at\)/,
    );
  });

  it('3. nenhum dado do lote entra na string: só em `values`', () => {
    // Sentinela impossível de confundir com identificador ou palavra do SQL.
    const sentinel = (label: string) => `${label}-9f2c41e7`;
    const batch = [
      skill({
        source_key: 'acme/toolbox/sentinel',
        name: sentinel('NAME'),
        summary: sentinel('SUMMARY'),
        source_url: `https://example.test/${sentinel('URL')}`,
      }),
    ];

    const statement = buildUpsertStatement(batch, CAPTURED_AT);

    // Prova de que não há injeção: o texto da statement é constante para qualquer lote.
    for (const literal of ['NAME', 'SUMMARY', 'URL']) {
      const token = sentinel(literal);
      expect(statement.sql).not.toContain(token);
      expect(statement.sql.toLowerCase()).not.toContain(token.toLowerCase());
    }

    // E o dado não sumiu: ele está nos parâmetros.
    expect(statement.values).toContain(sentinel('NAME'));
    expect(statement.values).toContain(sentinel('SUMMARY'));
    expect(statement.values).toContain(`https://example.test/${sentinel('URL')}`);

    // Controle embutido (anti-vacuidade): o texto é o **mesmo** para outro lote, e os valores são
    // **outros**. Se a função ignorasse a entrada, a 2ª igualdade falharia; se concatenasse dado
    // na string, a 1ª falharia.
    const other = buildUpsertStatement(
      [skill({ source_key: 'acme/toolbox/other', name: 'OTHER-NAME', summary: null })],
      CAPTURED_AT,
    );
    expect(other.sql).toBe(statement.sql);
    expect(other.values).not.toEqual(statement.values);
    expect(other.values).toContain('OTHER-NAME');
  });

  it('4. `values` tem 16 parâmetros por linha, na ordem das colunas', () => {
    const one = buildUpsertStatement([skill()], CAPTURED_AT);
    const three = buildUpsertStatement(threeDistinctSkills(), CAPTURED_AT);

    expect(one.values).toHaveLength(PARAMS_PER_ROW);
    expect(three.values).toHaveLength(PARAMS_PER_ROW * 3);

    // Ordem do `VALUES`: source_key, source_url, category_slug, name, summary, repo_url, stars,
    // installs, vulnerability_count, security_status, skill_md_present, first_seen_at, last_seen_at
    // — e então `true` (literal, não parâmetro) para `is_active`, `raw` serializado e os dois
    // insumos do `to_tsvector`.
    const row = three.values.slice(0, PARAMS_PER_ROW);
    expect(row[0]).toBe('acme/toolbox/alpha');
    expect(row[1]).toBe('https://skills.sh/acme/toolbox/find-skills');
    expect(row[2]).toBe('discovery');
    expect(row[3]).toBe('alpha');
    expect(row[4]).toBe('Finds skills for the current task');
    expect(row[6]).toBe(1); // stars do primeiro
    expect(row[10]).toBe(true); // skill_md_present
    expect(row[11]).toEqual(new Date('2026-11-01T00:00:00.000Z')); // first_seen_at da fonte
    expect(row[12]).toEqual(CAPTURED_AT); // last_seen_at = startedAt do run

    // `raw` é serializado como **parâmetro único**, nunca concatenado na string.
    expect(row[13]).toBe(JSON.stringify({ rank: 1 }));
    // O tsvector consome `name` e `summary` de novo — por isso 16 e não 14.
    expect(row[14]).toBe('alpha');
    expect(row[15]).toBe('Finds skills for the current task');
  });

  it('5. duas entradas da mesma source_key viram uma linha e a última vence', () => {
    const repeated = [
      skill({ source_key: 'acme/toolbox/dup', stars: 11, name: 'first-wins?' }),
      skill({ source_key: 'acme/toolbox/dup', stars: 42, name: 'last-wins' }),
    ];

    const statement = buildUpsertStatement(repeated, CAPTURED_AT);

    // Uma linha só: 16 parâmetros, não 32.
    expect(statement.values).toHaveLength(PARAMS_PER_ROW);
    expect(statement.values[0]).toBe('acme/toolbox/dup');
    // `stars` é o 7º parâmetro da linha; a ocorrência posterior do lote é a que fica.
    expect(statement.values[6]).toBe(42);
    expect(statement.values[3]).toBe('last-wins');

    // Controle: duas chaves distintas continuam sendo duas linhas (32 parâmetros). Sem esta
    // comparação o caso passaria mesmo se a função devolvesse uma linha só para tudo.
    const distinct = buildUpsertStatement(
      [
        skill({ source_key: 'acme/toolbox/dup', stars: 11 }),
        skill({ source_key: 'acme/toolbox/other', stars: 42 }),
      ],
      CAPTURED_AT,
    );
    expect(distinct.values).toHaveLength(PARAMS_PER_ROW * 2);
  });
});

describe('catalog SQL — snapshot de métrica (bloco B)', () => {
  it('6. compara NULL com NULL, filtra o que não mudou e é idempotente no mesmo captured_at', () => {
    const statement = buildMetricSnapshotStatement(threeDistinctSkills(), CAPTURED_AT);

    // As três métricas: `NULL = NULL` é `NULL` em SQL, então a comparação tem que ser
    // `IS NOT DISTINCT FROM` — senão `vulnerability_count` (sempre `null`, decisão D3) gravaria
    // um snapshot novo em todo run.
    expect([...statement.sql.matchAll(/IS NOT DISTINCT FROM/g)]).toHaveLength(3);
    expect(statement.sql).toMatch(/latest\.stars IS NOT DISTINCT FROM s\.stars/);
    expect(statement.sql).toMatch(/latest\.installs IS NOT DISTINCT FROM s\.installs/);
    expect(statement.sql).toMatch(
      /latest\.vulnerability_count IS NOT DISTINCT FROM s\.vulnerability_count/,
    );

    // Grava só quando a métrica mudou desde o último snapshot anterior a `capturedAt`.
    expect(statement.sql).toContain('NOT EXISTS');
    expect(statement.sql).toContain('INSERT INTO "skill_metric_snapshot"');
    expect(statement.sql).toContain('ON CONFLICT (skill_id, captured_at) DO NOTHING');

    // A chave do lote entra como parâmetro, não como lista literal.
    expect(statement.sql).toContain('s.source_key IN (');
    expect(statement.values).toContain('acme/toolbox/alpha');
    expect(statement.values).toContain('acme/toolbox/gamma');
  });

  it('7. `capturedAt` vai nos valores duas vezes e nunca como now() no SQL', () => {
    const statement = buildMetricSnapshotStatement(threeDistinctSkills(), CAPTURED_AT);

    // 1 `capturedAt` na projeção + 3 chaves + 1 `capturedAt` na subquery do último snapshot.
    expect(statement.values).toHaveLength(3 + 2);
    expect(statement.values[0]).toEqual(CAPTURED_AT);
    expect(statement.values[statement.values.length - 1]).toEqual(CAPTURED_AT);

    // Determinismo: dois runs no mesmo `startedAt` produzem a mesma statement.
    expect(statement.sql).not.toMatch(/\bnow\s*\(/i);
    expect(statement.sql).not.toMatch(/current_timestamp/i);
    expect(buildMetricSnapshotStatement(threeDistinctSkills(), CAPTURED_AT).sql).toBe(
      statement.sql,
    );
  });
});

/**
 * Repositório de duplo para o bloco C: o mínimo da porta, com a semântica que a porta declara —
 * `upsertSkills` devolve **quantas linhas de `skill` foram gravadas**, isto é, o número de
 * `source_key` distintas, como `INSERT ... ON CONFLICT (source_key) DO UPDATE`.
 */
class RecordingRepository implements CatalogRepository {
  readonly finishes: IngestRunFinish[] = [];
  readonly upsertCalls: SkillRecord[][] = [];
  private nextRunId = 1;

  failStaleRuns(_startedBefore: Date): Promise<number> {
    return Promise.resolve(0);
  }

  startRun(_run: { adapter: string; started_at: Date }): Promise<number> {
    const id = this.nextRunId;
    this.nextRunId += 1;
    return Promise.resolve(id);
  }

  finishRun(_id: number, patch: IngestRunFinish): Promise<void> {
    this.finishes.push(patch);
    return Promise.resolve();
  }

  countActiveSkills(): Promise<number> {
    return Promise.resolve(0);
  }

  selectRotationKeys(_params: RotationParams): Promise<string[]> {
    return Promise.resolve([]);
  }

  upsertSkills(skills: SkillRecord[]): Promise<number> {
    this.upsertCalls.push(skills);
    return Promise.resolve(new Set(skills.map((item) => item.source_key)).size);
  }

  deactivateSkillsNotSeenSince(_seenAt: Date): Promise<number> {
    return Promise.resolve(0);
  }

  deactivateSkillsStaleBefore(_cutoff: Date): Promise<number> {
    return Promise.resolve(0);
  }
}

/** Fonte que entrega exatamente estes itens na página 1 e nada depois. */
function staticSource(items: SkillRecord[]): SkillSource {
  return {
    capabilities: { supports_categories: false, supports_documents: false },
    listCategories: () => Promise.resolve([]),
    // A ingestão de hoje pagina; quem pede chaves é o rodízio (#44, #46).
    fetchSkills: () => Promise.resolve([]),
    fetchCatalog: (pageNumber: number) =>
      Promise.resolve({ items: pageNumber === 1 ? items : [], page: pageNumber, has_more: false }),
    fetchDocument: () => Promise.resolve(null),
  };
}

describe('catalog ingest — items_seen conta chaves distintas (bloco C)', () => {
  it('8. 3 itens com uma source_key repetida: items_seen === 2, upserted === 2, run ok', async () => {
    const repository = new RecordingRepository();
    const duplicated = [
      skill({ source_key: 'acme/toolbox/find-skills', stars: 10 }),
      skill({ source_key: 'acme/toolbox/other-skill', stars: 20 }),
      // A mesma skill de novo (destaque + listagem): uma linha em `skill`, um item "recebido".
      skill({ source_key: 'acme/toolbox/find-skills', stars: 11 }),
    ];

    const outcome = await ingest({
      source: staticSource(duplicated),
      repository,
      adapter: 'fixture',
      startedAt: CAPTURED_AT,
    });

    // Unidade única: a razão `upserted / seen` só mede perda se os dois lados contarem linhas
    // de `skill` (chaves distintas), não itens da página. Ver o cabeçalho deste spec: a regra
    // ratificada dizia "itens recebidos" e o dono decidiu contar distintas.
    expect(outcome.items_seen).toBe(2);
    expect(outcome.items_upserted).toBe(2);
    expect(outcome.status).toBe('ok');
    expect(outcome.error_code).toBeNull();

    // O mesmo número foi para `ingest_run` — o painel não pode discordar do resultado.
    const finished = repository.finishes[0];
    expect(finished).toBeDefined();
    expect(finished.items_seen).toBe(2);
    expect(finished.items_upserted).toBe(2);
    expect(finished.status).toBe('ok');
  });

  it('8b. a razão usa a mesma unidade: 5 itens com 2 chaves não viram partial', async () => {
    const repository = new RecordingRepository();
    const page = [
      skill({ source_key: 'acme/toolbox/a', stars: 1 }),
      skill({ source_key: 'acme/toolbox/b', stars: 2 }),
      skill({ source_key: 'acme/toolbox/a', stars: 3 }),
      skill({ source_key: 'acme/toolbox/b', stars: 4 }),
      skill({ source_key: 'acme/toolbox/a', stars: 5 }),
    ];

    const outcome = await ingest({
      source: staticSource(page),
      repository,
      adapter: 'fixture',
      startedAt: CAPTURED_AT,
    });

    // Contando itens recebidos, a razão seria 2/5 = 0,4 < 0,5 e o run cairia para `partial` com
    // `LOW_UPSERT_RATIO` — mesmo tendo gravado 100% das chaves. É o defeito que o caso fixa.
    expect(outcome.items_seen).toBe(2);
    expect(outcome.items_upserted).toBe(2);
    expect(outcome.status).toBe('ok');
    expect(outcome.error_code).toBeNull();
  });
});
