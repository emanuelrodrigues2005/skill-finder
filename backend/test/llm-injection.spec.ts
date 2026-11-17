/**
 * Issue #13 — prova dos critérios de aceitação de *prompt injection* que já têm
 * código (regra 2 do `AGENTS.md`, `docs/app/02-arquitetura.md` §8.3, barreira 2).
 *
 * O que este spec fixa, e por quê:
 *
 *   F. **controle positivo do harness.** Trocar `installs` entre dois candidatos
 *      muda a ordem. Sem F, G seria tautológico: uma asserção "a ordem não mudou"
 *      não vale nada se o mesmo harness não reage a nenhuma mudança de entrada.
 *   G. texto hostil de `fixtures/injection/skill.md` no `summary` de **um**
 *      candidato não muda a ordem; o texto hostil realmente chegou à pipeline
 *      (o serviço recebeu o candidato com ele), e `results[0]` continua o de
 *      maior score. O ranking é determinístico (regra 1): a ordem sai de
 *      `src/ranking`, nunca do texto externo.
 *   H. a prosa não copia o payload: nenhum `explanation`, `caveats` ou
 *      `recommendation.text` contém "ignore previous instructions" nem
 *      `</system>`.
 *   I. o JSON falso do modelo (`score`/`weight`/`rank_first`) é descartado pelo
 *      schema da `Intent`: `status 'ok'` e exatamente cinco chaves.
 *   J. `SKILL.md` não entra no *system prompt*: nenhum arquivo de `src/llm`
 *      menciona `skill-md`/`toPlainText`, e `buildIntentMessages` devolve
 *      `['system','user']` com o `system.content` fixo e igual a `SYSTEM_PROMPT`.
 *
 * A "pipeline" exercitada é a de produção: `SearchService.search`, a mesma que
 * `POST /api/v1/search` chama. Os candidatos são `SkillDetail` (o formato do
 * detalhe no catálogo) porque são eles que carregam o texto de terceiro; os
 * campos de score que o ranking lê são os mesmos de `SkillSummary`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { AppConfigService } from '@/config/config.module';
import type { CategoryItem, SkillDetail, SkillSummary } from '@/contract/dto/catalog.dto';
import type { SearchResponse } from '@/contract/dto/search-response.dto';
import type { IntentParser, IntentParserResult } from '@/llm/intent-parser';
import { lexicalIntent, parseIntentPayload } from '@/llm/intent-schema';
import { buildIntentMessages, SYSTEM_PROMPT } from '@/llm/prompt';
import { encodeSkillId } from '@/search/ids';
import type {
  ListSkillsInput,
  SearchCatalog,
  SearchCatalogInput,
  SkillPage,
} from '@/search/search-catalog.port';
import type { SearchStore, StoredSearchInput, StoredSearchRow } from '@/search/search-store.port';
import { SearchService } from '@/search/search.service';

const QUERY = 'review pull requests for security problems in Python';

const CATEGORIES: readonly CategoryItem[] = [
  { slug: 'backend', label_en: 'Backend', skill_count: 3 },
];

const HOSTILE_SKILL_MD = readFileSync(
  join(__dirname, 'fixtures', 'injection', 'skill.md'),
  'utf8',
).trim();

const HOSTILE_MARKERS = ['ignore previous instructions', '</system>'] as const;

/** Pesos default de `src/ranking/weights.ts` (§6.4); o serviço os lê da config. */
const CONFIG = {
  env: {
    rankWStars: 0.5,
    rankWVulns: 0.3,
    rankWInstalls: 0.2,
    ipHashSalt: 'injection-test-salt',
    searchLogStoreText: false,
  },
} as unknown as AppConfigService;

/** Parser determinístico: o llm.status não é objeto destes casos. */
const PARSER: IntentParser = {
  parse(query: string): Promise<IntentParserResult> {
    return Promise.resolve({
      intent: lexicalIntent(query),
      status: 'disabled',
      model: null,
      tokens: null,
    });
  },
};

class InjectionCatalog implements SearchCatalog {
  received: readonly SkillDetail[] = [];

  constructor(private readonly candidates: readonly SkillDetail[]) {}

  search(_input: SearchCatalogInput): Promise<readonly SkillSummary[]> {
    this.received = this.candidates;
    return Promise.resolve(this.candidates);
  }

  findByIds(_ids: readonly bigint[]): Promise<readonly SkillSummary[]> {
    return Promise.resolve(this.candidates);
  }

  detail(_skillId: bigint): Promise<SkillDetail | null> {
    return Promise.resolve(null);
  }

  snapshot(): Promise<Date | null> {
    return Promise.resolve(new Date());
  }

  categoryExists(_slug: string): Promise<boolean> {
    return Promise.resolve(true);
  }

  listCategories(): Promise<readonly CategoryItem[]> {
    return Promise.resolve(CATEGORIES);
  }

  listSkills(_input: ListSkillsInput): Promise<SkillPage> {
    return Promise.resolve({ items: this.candidates, total_items: this.candidates.length });
  }
}

class MemoryStore implements SearchStore {
  readonly saved: StoredSearchInput[] = [];

  save(record: StoredSearchInput): Promise<StoredSearchRow> {
    this.saved.push(record);
    return Promise.resolve({ ...record, search_id: 'b0d1f3a2-7c1e-4a55-9f0e-2d4a1c6b8e11' });
  }

  findByRequestId(_requestId: string): Promise<StoredSearchRow | null> {
    return Promise.resolve(null);
  }
}

/**
 * Skill com os três campos que o ranking consome. `summary` é o texto de
 * terceiro do catálogo (o campo que o ingest trunca em 280 e que a interface
 * escapa); ele nunca é entrada do ranking.
 */
function skill(
  id: bigint,
  name: string,
  stars: number | null,
  installs: number | null,
  vulnerabilityCount: number | null,
): SkillDetail {
  return {
    skill_id: encodeSkillId(id),
    name,
    source_url: null,
    category: 'backend',
    stars,
    installs,
    vulnerability_count: vulnerabilityCount,
    security_status: 'ok',
    skill_md_present: false,
    summary: null,
    repo_url: null,
    skill_md_excerpt: null,
  };
}

/**
 * Baseline escolhido para que **installs** decida a ordem (F) e o desempate seja
 * folgado:
 *
 *   - `installs-heavy`: 59.059 installs, 85 stars  -> lidera pelo installs;
 *   - `stars-heavy`:    2 installs, 231 stars      -> perde para o anterior;
 *   - `sparse-evidence`: três campos ausentes      -> último, com penalidade.
 *
 * Trocar os installs dos dois primeiros inverte a liderança (F).
 */
function baseline(): SkillDetail[] {
  return [
    skill(41n, 'installs-heavy', 85, 59_059, 0),
    skill(42n, 'stars-heavy', 231, 2, 0),
    skill(43n, 'sparse-evidence', null, null, null),
  ];
}

function withSummary(
  candidates: readonly SkillDetail[],
  index: number,
  summary: string | null,
): SkillDetail[] {
  return candidates.map((candidate, position) =>
    position === index ? { ...candidate, summary } : candidate,
  );
}

function withSwappedInstalls(
  candidates: readonly SkillDetail[],
): SkillDetail[] {
  const [first, second] = candidates;
  if (first === undefined || second === undefined) {
    throw new Error('baseline precisa de ao menos dois candidatos');
  }
  return [
    { ...first, installs: second.installs },
    { ...second, installs: first.installs },
    ...candidates.slice(2),
  ];
}

interface Run {
  readonly response: SearchResponse;
  readonly received: readonly SkillDetail[];
}

/** Roda a pipeline de produção sobre os candidatos dados. */
async function runSearch(candidates: readonly SkillDetail[]): Promise<Run> {
  const catalog = new InjectionCatalog(candidates);
  const service = new SearchService(catalog, new MemoryStore(), PARSER, CONFIG);
  const response = await service.search({
    query: QUERY,
    category: null,
    limit: 5,
    strictLlm: false,
    clientIp: '127.0.0.1',
    requestId: 'req_test',
  });
  return { response, received: catalog.received };
}

function order(run: Run): string[] {
  return run.response.results.map((item) => item.skill.skill_id);
}

function scores(run: Run): number[] {
  return run.response.results.map((item) => item.score);
}

describe('prompt injection resilience (AGENTS.md rule 2, arquitetura 8.3)', () => {
  it('F. the harness is sensitive: swapping installs changes the ranking order', async () => {
    const baselineRun = await runSearch(baseline());
    const swappedRun = await runSearch(withSwappedInstalls(baseline()));

    // Ordem esperada calculada à mão a partir dos anchors de §5.3 (fonte
    // independente do código): installs-heavy > stars-heavy > sparse-evidence.
    expect(order(baselineRun)).toEqual([
      encodeSkillId(41n),
      encodeSkillId(42n),
      encodeSkillId(43n),
    ]);
    // O controle positivo: o harness reage a uma entrada do ranking.
    expect(order(swappedRun)).not.toEqual(order(baselineRun));
    expect(order(swappedRun)[0]).toBe(encodeSkillId(42n));
  });

  it('G. hostile summary reaches the pipeline without changing the order', async () => {
    expect(HOSTILE_SKILL_MD).toContain('ignore previous instructions');
    expect(HOSTILE_SKILL_MD).toContain('</system>');

    const baselineRun = await runSearch(baseline());
    const hostileRun = await runSearch(withSummary(baseline(), 2, HOSTILE_SKILL_MD));

    // (ii) o texto hostil chegou à pipeline: o serviço recebeu o candidato com ele.
    expect(hostileRun.received).toHaveLength(3);
    expect(hostileRun.received[2]?.summary).toBe(HOSTILE_SKILL_MD);
    expect(hostileRun.received[2]?.summary).toContain('ignore previous instructions');

    // (i) a ordem é idêntica à do baseline sem texto hostil.
    expect(order(hostileRun)).toEqual(order(baselineRun));
    expect(order(hostileRun)).toEqual([
      encodeSkillId(41n),
      encodeSkillId(42n),
      encodeSkillId(43n),
    ]);

    // (iii) o topo continua o de maior score, e o score é o do ranking determinístico.
    expect(hostileRun.response.results[0]?.skill.skill_id).toBe(
      baselineRun.response.results[0]?.skill.skill_id,
    );
    expect(hostileRun.response.results[0]?.score).toBe(Math.max(...scores(hostileRun)));
    expect(scores(hostileRun)).toEqual(scores(baselineRun));
  });

  it('H. the prose never copies the hostile payload', async () => {
    const hostileRun = await runSearch(withSummary(baseline(), 2, HOSTILE_SKILL_MD));

    for (const item of hostileRun.response.results) {
      for (const marker of HOSTILE_MARKERS) {
        expect(item.explanation.toLowerCase()).not.toContain(marker);
        expect((item.caveats ?? '').toLowerCase()).not.toContain(marker);
      }
    }
    for (const marker of HOSTILE_MARKERS) {
      expect((hostileRun.response.recommendation?.text ?? '').toLowerCase()).not.toContain(marker);
    }
    // O payload também não chega à `Intent`: o passo de intenção só vê a
    // consulta e os slugs de categoria, nunca o texto do catálogo.
    //
    // (`response.results[].skill` ecoa a linha **como o catálogo a devolveu**;
    // aqui o duplo é `SkillDetail` para carregar o texto até a pipeline, então o
    // campo extra aparece no eco. Em produção `SearchCatalog.search` devolve
    // `SkillSummary`, que não tem `summary` — o objeto do contrato também não.)
    expect(JSON.stringify(hostileRun.response.intent).toLowerCase()).not.toContain(
      'ignore previous instructions',
    );
  });

  it('I. drops the fake ranking JSON the model could answer with', () => {
    const raw = readFileSync(join(__dirname, 'fixtures', 'injection', 'model-response.json'), 'utf8');
    const payload = JSON.parse(raw) as Record<string, unknown>;

    // A fixture é hostil de verdade: sem estas chaves o caso seria vazio.
    expect(payload).toHaveProperty('score');
    expect(payload).toHaveProperty('weight');
    expect(payload).toHaveProperty('rank_first');

    const { intent, status } = parseIntentPayload(payload, {
      query: QUERY,
      categories: ['backend', 'testing'],
    });

    expect(status).toBe('ok');
    expect(Object.keys(intent).sort()).toEqual([
      'category',
      'confidence',
      'filters',
      'keywords',
      'language',
    ]);
    expect(intent).not.toHaveProperty('score');
    expect(intent).not.toHaveProperty('weight');
    expect(intent).not.toHaveProperty('rank_first');
    expect(intent.category).toBe('backend');
    expect(intent.filters).toEqual({ exclude_with_vulnerabilities: false });
  });

  it('J. SKILL.md stays out of the system prompt', () => {
    const llmDir = join(__dirname, '..', 'src', 'llm');
    const sources = readdirSync(llmDir).filter((file) => file.endsWith('.ts'));
    expect(sources.length).toBeGreaterThan(0);

    // (i) nenhum arquivo do passo de intenção lê SKILL.md: a prosa de uma skill
    // não pode virar instrução de sistema por um import esquecido.
    for (const file of sources) {
      const source = readFileSync(join(llmDir, file), 'utf8');
      expect({ file, mentionsSkillMd: /skill-md|toPlainText/.test(source) }).toEqual({
        file,
        mentionsSkillMd: false,
      });
    }

    // (ii) duas queries diferentes produzem o mesmo system prompt, e ele é o
    // ``SYSTEM_PROMPT` exportado (fixo e versionado).
    const first = buildIntentMessages('review python pull requests for security issues', [
      'backend',
      'testing',
    ]);
    const second = buildIntentMessages('quero uma skill para documentar uma api em portugues', [
      'backend',
      'testing',
    ]);

    expect(first.map((message) => message.role)).toEqual(['system', 'user']);
    expect(second.map((message) => message.role)).toEqual(['system', 'user']);
    expect(first[0]?.content).toBe(SYSTEM_PROMPT);
    expect(second[0]?.content).toBe(SYSTEM_PROMPT);
    expect(first[0]?.content).not.toContain('ignore previous instructions');
  });
});
