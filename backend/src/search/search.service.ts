/**
 * Orquestração da busca (`docs/app/02-arquitetura.md` §5.2–§5.4, §6, §7.4).
 *
 * O caminho é sempre o mesmo, e nenhuma etapa conhece a implementação da outra:
 *
 *   categoria (D-A) -> snapshot do cache (503) -> intenção (LLM ou fallback)
 *   -> candidatos -> ranking determinístico -> explicação (LLM ou template)
 *   -> persistência
 *
 * Invariantes que valem aqui dentro:
 * - o ranking é do servidor (regra 1): a LLM só entrega a `Intent` e a prosa, e a
 *   ordem sai de `src/ranking`, uma função pura;
 * - dado ausente é `null`, nunca zero (regra 3): a lacuna vira
 *   `evidence_completeness`/`caveats`, não um `0` inventado;
 * - degradação é visível (regra 7): catálogo velho ou LLM fora do ar mudam
 *   `data.degraded` e `warnings`, nunca a resposta em silêncio;
 * - o `request_id` da resposta é cunhado aqui (C4), não vem do header;
 * - a prosa do passo 7 é **sempre** renderizada por `explainItem` (issue #42):
 *   o `why` do agente carrega `{{skill:<id>}}` e nunca é copiado direto para a
 *   resposta.
 */
import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';

import { ERROR_CODES } from '../common/errors/error-codes';
import { ApiError } from '../common/errors/http-exception.filter';
import { MetricsService } from '../common/metrics/metrics.service';
import { AppConfigService } from '../config/config.module';
import { DEFAULT_LLM_TOTAL_DEADLINE_MS } from '../config/env.schema';
import type { CategoryItem, SkillDetail, SkillSummary } from '../contract/dto/catalog.dto';
import type {
  Intent,
  LlmStatus,
  Recommendation,
  SearchResponse,
} from '../contract/dto/search-response.dto';
import type { ResultItem } from '../contract/dto/result-item.dto';
import { resolveDegradation } from '../llm/degradation';
import type {
  ExplainCandidate,
  ExplainParser,
  ExplainRequest,
  ExplainResult,
} from '../llm/explain-parser';
import type { IntentParser, IntentParserResult } from '../llm/intent-parser';
import { MIN_CONFIDENCE } from '../llm/intent-schema';
import { EXPLAIN_PORT, INTENT_PARSER } from '../llm/llm.module';
import { rank } from '../ranking';
import type { RankingWeights } from '../ranking';

import { clientHash, sha256Hex } from './client-hash';
import {
  CANDIDATE_POOL_SIZE,
  SEARCH_HISTORY_RETENTION_MS,
  SEARCH_WARNINGS,
  SOURCE_STALE_AFTER_MS,
  SOURCE_UNAVAILABLE_REASON,
  VALIDATION_REASON,
} from './constants';
import {
  EXPLANATION_REPAIRED_FLAG,
  explainItem,
  recommend,
  type ExplanationItem,
} from './explanation';
import { decodeSkillId } from './ids';
import { mintSearchRequestId } from './request-id';
import type { ListSkillsInput, SearchCatalog, SkillPage } from './search-catalog.port';
import type {
  SearchStore,
  StoredSearchInput,
  StoredSearchStatus,
} from './search-store.port';
import { storedSearchJson } from './search-store.port';
import { SEARCH_CATALOG, SEARCH_STORE } from './search.tokens';

/** Entrada de `POST /api/v1/search` já validada pelo DTO (§5.2). */
export interface SearchInput {
  readonly query: string;
  /** Slug existente ou `null` (D-A: inexistente é 422). */
  readonly category: string | null;
  /** 1–20, já limitado pelo DTO. */
  readonly limit: number;
  /** `?strict_llm=true`: falha em 502 em vez de degradar (§5.5). */
  readonly strictLlm: boolean;
  /** IP já resolvido pelo Express (`trust proxy`); nunca persistido em claro. */
  readonly clientIp: string;
  /** Header recebido: **opaco**, nunca vira chave do histórico (C4). */
  readonly requestId: string;
}

/** `GET /api/v1/categories` — o único payload com `data_snapshot` (§5.4). */
export interface CategoryList {
  readonly data: readonly CategoryItem[];
  readonly data_snapshot: string;
}

/**
 * Orçamento e dados do passo 7 (issue #42, §6.5).
 *
 * O instante-limite é calculado **uma** vez, no começo de
 * {@link SearchService.search}, e entregue aos dois passos de LLM: sem isso cada
 * etapa ganharia `LLM_TOTAL_DEADLINE_MS` próprio e o teto somado (7 s) não
 * valeria — a intenção poderia gastar 3 s e a explicação mais 4 s a partir dali.
 */
interface ExplainBudget {
  readonly deadlineAtMs: number;
  /** `data.catalog_snapshot`: entra na chave do cache de explicação (§4.1). */
  readonly catalogSnapshot: string;
  /**
   * `false` quando a intenção é fraca demais para valer a prosa: o passo 7 não é
   * tentado e `explain_status` fica `null` (ausência, não falha).
   */
  readonly attempt: boolean;
}

/**
 * Estados em que `strict_llm=true` troca a degradação por 502.
 *
 * `low_confidence` fica de fora: confiança baixa é um resultado legítimo, não um
 * provedor que respondeu lixo.
 */
const STRICT_FAILURE_STATUSES: ReadonlySet<LlmStatus> = new Set<LlmStatus>([
  'unavailable',
  'invalid_ids',
]);

@Injectable()
export class SearchService {
  constructor(
    @Inject(SEARCH_CATALOG) private readonly catalog: SearchCatalog,
    @Inject(SEARCH_STORE) private readonly store: SearchStore,
    @Inject(INTENT_PARSER) private readonly parser: IntentParser,
    private readonly config: AppConfigService,
    // Passo 7 (§6.5): a porta que redige o porquê. Fica ao lado do `IntentParser`
    // porque as duas saem do mesmo cliente — e é o único caminho da prosa até a
    // resposta (issue #42).
    @Inject(EXPLAIN_PORT) private readonly explain: ExplainParser,
    // Opcional de propósito: a métrica é observabilidade, não requisito da busca.
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  /**
   * Executa uma busca completa e persiste o histórico (US-09).
   *
   * @throws ApiError 422 de categoria inexistente (D-A), 503 de cache vazio,
   *   502 quando `strict_llm=true` e o provedor respondeu inválido.
   */
  async search(input: SearchInput): Promise<SearchResponse> {
    const startedAt = process.hrtime.bigint();
    // Um orçamento só para os dois passos de LLM (#42): o instante-limite nasce
    // aqui, antes da intenção, e é o mesmo que a explicação recebe depois.
    const deadlineAtMs = this.llmDeadlineAt();

    // D-A: a categoria é um enum fechado; validar antes do cache evita pagar
    // uma consulta de recuperação para responder 422 depois.
    if (input.category !== null && !(await this.catalog.categoryExists(input.category))) {
      throw unknownCategory(input.category);
    }

    const snapshot = await this.catalog.snapshot();
    if (snapshot === null) {
      throw cacheEmpty();
    }
    const catalogSnapshot = snapshot.toISOString();

    // O vocabulário de categorias é o do catálogo do momento: a intenção que
    // citar uma categoria fora dele é reparada por `parseIntentPayload` (§6.3).
    const categories = await this.catalog.listCategories();
    const parsed = await this.parseIntent(input.query, categories, deadlineAtMs);
    this.observeLlmCall(parsed.status);
    if (input.strictLlm && STRICT_FAILURE_STATUSES.has(parsed.status)) {
      throw new ApiError(
        HttpStatus.BAD_GATEWAY,
        ERROR_CODES.LLM_BAD_RESPONSE,
        'The language model answered invalid and the call did not degrade (strict_llm=true).',
      );
    }

    const now = new Date();
    const ageMs = Math.max(0, now.getTime() - snapshot.getTime());
    const degradation = resolveDegradation(parsed.status, ageMs > SOURCE_STALE_AFTER_MS);

    const candidates = await this.catalog.search({
      query: input.query,
      // Issue #40: o `search_doc` é indexado em inglês, então o `tsquery` recebe os
      // termos em inglês da intenção. Sem eles (provedor `disabled`, intenção
      // reparada, campo ausente) caem as `keywords` da consulta: a busca responde
      // menos, jamais deixa de responder. A consulta crua segue no `query`, que só
      // serve ao `name ILIKE`.
      keywords: searchKeywords(parsed),
      category: input.category,
      limit: Math.max(input.limit, CANDIDATE_POOL_SIZE),
    });
    const { results, recommendation, warnings, explainStatus } = await this.rankAndExplain(
      input.query,
      candidates,
      parsed.intent,
      input.limit,
      // `source_stale` fala do **frescor do snapshot**, não da degradação:
      // `resolveDegradation` também marca `disabled`/`unavailable`/`invalid_ids`/
      // `low_confidence`, então amarrar o aviso em `degradation.degraded` diria
      // "catálogo velho" com snapshot fresco (o default de dev/CI, sem LLM).
      ageMs > SOURCE_STALE_AFTER_MS ? SEARCH_WARNINGS.sourceStale : null,
      {
        deadlineAtMs,
        catalogSnapshot,
        // A prosa não vale a chamada quando a intenção é fraca (ver `ExplainBudget`).
        attempt: parsed.intent.confidence >= MIN_CONFIDENCE,
      },
    );

    const record: StoredSearchInput = {
      request_id: mintSearchRequestId(),
      created_at: now,
      client_hash: clientHash(input.clientIp, this.config.env.ipHashSalt),
      query_hash: sha256Hex(input.query),
      // §8.5: sem `SEARCH_LOG_STORE_TEXT` o histórico guarda só o hash.
      query_text: this.config.env.searchLogStoreText ? input.query : null,
      intent: parsed.intent,
      category_slug: input.category,
      result_ids: toBigIntIds(results),
      candidates_count: candidates.length,
      llm_status: parsed.status,
      degraded: degradation.degraded,
      latency_ms: elapsedMs(startedAt),
      status: storedStatus(results.length, degradation.degraded),
      toJSON: () => storedSearchJson(record),
    };
    const stored = await this.store.save(record);

    return {
      request_id: stored.request_id,
      search_id: stored.search_id,
      intent: parsed.intent,
      llm: {
        status: parsed.status,
        model: parsed.model,
        cached: false,
        tokens: parsed.tokens,
        // `explain_status` é `required` + `nullable` no contrato: sempre presente,
        // `null` quando o passo 7 não foi tentado (budget, `disabled`, sem
        // candidato, confiança baixa).
        explain_status: explainStatus,
      },
      data: {
        degraded: degradation.degraded,
        degraded_reason: degradation.degraded_reason,
        source: 'cache',
        catalog_snapshot: catalogSnapshot,
        age_seconds: Math.round(ageMs / 1000),
      },
      results,
      recommendation,
      warnings,
    };
  }

  /**
   * Replay de uma busca gravada — o permalink de §5.4 (decisão D-D).
   *
   * O **conjunto** de ids é o gravado; **score e ordem são recalculados** pela
   * mesma função pura, sobre o snapshot atual do catálogo — servir `score` velho
   * seria pior que devolver ordem recalculada (decisão ratificada). Ids que
   * saíram do catálogo desde então não entram. `llm.cached` vem `true` e
   * `model`/`tokens` nulos: nenhum provedor foi chamado nesta leitura.
   *
   * @throws ApiError 404 para id desconhecido, 410 além da retenção de 30 dias.
   */
  async replay(requestId: string): Promise<SearchResponse> {
    const row = await this.store.findByRequestId(requestId);
    if (row === null) {
      throw new ApiError(HttpStatus.NOT_FOUND, ERROR_CODES.NOT_FOUND, 'Search not found.');
    }

    const now = new Date();
    if (now.getTime() - row.created_at.getTime() > SEARCH_HISTORY_RETENTION_MS) {
      throw new ApiError(
        HttpStatus.GONE,
        ERROR_CODES.HISTORY_EXPIRED,
        'Search history expired: the permalink is kept for 30 days.',
        { expires_at: new Date(row.created_at.getTime() + SEARCH_HISTORY_RETENTION_MS).toISOString() },
      );
    }

    const found = await this.catalog.findByIds(row.result_ids);
    const byId = new Map<string, SkillSummary>();
    for (const skill of found) {
      const id = decodeSkillId(skill.skill_id);
      if (id !== null) {
        byId.set(id.toString(), skill);
      }
    }
    // `result_ids` é o conjunto gravado, na ordem original; ids que saíram do
    // catálogo desde então não entram e a ordem final é a do re-rank sobre o
    // snapshot atual, aplicado adiante por `rankAndExplain`.
    const storedOrder = row.result_ids
      .map((id) => byId.get(id.toString()))
      .filter((skill): skill is SkillSummary => skill !== undefined);

    const snapshot = await this.catalog.snapshot();
    const ageMs = Math.max(0, now.getTime() - (snapshot ?? row.created_at).getTime());
    const degradation = resolveDegradation(row.llm_status, ageMs > SOURCE_STALE_AFTER_MS);

    const { results, recommendation, warnings } = await this.rankAndExplain(
      // O replay não explica, mas a assinatura é a mesma dos dois caminhos: a
      // consulta gravada pode nem existir (`SEARCH_LOG_STORE_TEXT=false`).
      row.query_text ?? '',
      storedOrder,
      row.intent,
      storedOrder.length,
      // Mesmo critério da busca: frescor do snapshot, nunca o status da LLM.
      ageMs > SOURCE_STALE_AFTER_MS ? SEARCH_WARNINGS.sourceStale : null,
      // Hit do cache de busca: o passo 7 não é tentado (nenhum provedor é
      // chamado numa leitura de permalink), e o texto volta do template.
      null,
    );

    return {
      request_id: row.request_id,
      search_id: row.search_id,
      intent: row.intent,
      llm: {
        status: row.llm_status,
        model: null,
        tokens: null,
        cached: true,
        // Replay não chama provedor nenhum: a explicação nunca foi tentada.
        explain_status: null,
      },
      data: {
        degraded: degradation.degraded,
        degraded_reason: degradation.degraded_reason,
        source: 'cache',
        catalog_snapshot: (snapshot ?? row.created_at).toISOString(),
        age_seconds: Math.round(ageMs / 1000),
      },
      results,
      recommendation,
      warnings,
    };
  }

  /**
   * Categorias do snapshot para o seletor da interface (§5.4).
   *
   * @throws ApiError 503 quando o catálogo nunca foi ingerido — sem snapshot não
   *   existe `data_snapshot` honesto para prometer.
   */
  async categories(): Promise<CategoryList> {
    const snapshot = await this.catalog.snapshot();
    if (snapshot === null) {
      throw cacheEmpty();
    }
    return {
      data: await this.catalog.listCategories(),
      data_snapshot: snapshot.toISOString(),
    };
  }

  /** Página de `GET /api/v1/skills`; os limites já chegam validados do controller. */
  async skills(input: ListSkillsInput): Promise<SkillPage> {
    return this.catalog.listSkills(input);
  }

  /**
   * Detalhe de uma skill (§5.4).
   *
   * A data de referência do dado (`data_snapshot`) não é coluna da linha: ela vem
   * do `snapshot()` do catálogo — a mesma fonte que a busca publica em
   * `data.catalog_snapshot` —, formatada em RFC 3339 UTC pelo `toISOString()`, o
   * mesmo formato de `/categories`. Sem snapshot (catálogo nunca ingerido) o campo
   * é `null` e a tela mostra `n/a` (regra 3).
   *
   * @throws ApiError 404 quando o id não existe — o mesmo 404 de um id malformado,
   *   que o controller nem chega a decodificar.
   */
  async skillDetail(skillId: bigint): Promise<SkillDetail> {
    const detail = await this.catalog.detail(skillId);
    if (detail === null) {
      throw new ApiError(HttpStatus.NOT_FOUND, ERROR_CODES.NOT_FOUND, 'Skill not found.');
    }
    // O `snapshot()` é consultado só depois do 404: um id inexistente não paga
    // uma segunda ida ao catálogo.
    const snapshot = await this.catalog.snapshot();
    return {
      ...detail,
      data_snapshot: snapshot === null ? null : snapshot.toISOString(),
    };
  }

  /**
   * Ranqueia, explica e monta o envelope comum a busca e permalink.
   *
   * O passo 7 (`explain`) só é tentado quando `budget` não é `null`, ou seja: na
   * busca nova, com intenção confiável e com candidato. O replay de um permalink
   * passa `null` — nenhum provedor é chamado numa leitura de histórico.
   */
  private async rankAndExplain(
    query: string,
    candidates: readonly SkillSummary[],
    intent: Intent,
    limit: number,
    staleWarning: string | null,
    budget: ExplainBudget | null,
  ): Promise<{
    results: ResultItem[];
    recommendation: Recommendation | null;
    warnings: string[];
    explainStatus: LlmStatus | null;
  }> {
    const bySkillId = new Map(candidates.map((skill) => [skill.skill_id, skill]));
    const ranked = rank(
      candidates.map((skill) => ({
        skill_id: skill.skill_id,
        stars: skill.stars,
        installs: skill.installs,
        vulnerability_count: skill.vulnerability_count,
      })),
      { excludeWithVulnerabilities: intent.filters.exclude_with_vulnerabilities },
      this.weights(),
    ).slice(0, Math.max(0, limit));

    // O conjunto de nomes que pode aparecer num placeholder é o ranqueado: a
    // explicação nunca cita uma skill fora da resposta (regra 1).
    const known = new Map<string, string>();
    const entries = ranked.flatMap((ranked) => {
      const skill = bySkillId.get(ranked.skill_id);
      if (skill === undefined) {
        return [];
      }
      known.set(ranked.skill_id, skill.name);
      return [{ row: ranked, skill }];
    });
    const items: ExplanationItem[] = entries.map(({ row, skill }) => ({
      skill,
      score_breakdown: row.score_breakdown,
      evidence_completeness: row.evidence_completeness,
    }));

    const explained = await this.explainRanked(query, items, intent, budget);

    const results: ResultItem[] = [];
    let fromTemplate = 0;
    for (const [index, item] of items.entries()) {
      const row = entries[index]?.row;
      if (row === undefined) {
        continue;
      }
      const prose = explained.items.get(item.skill.skill_id);
      // Issue #42: `items[].why` é **template** de `explainItem` — o único caminho
      // da prosa até a resposta. O placeholder `{{skill:<id>}}` é resolvido aqui e
      // o texto ainda passa pelos tetos e pelo escape do dado de terceiro.
      const explanation = explainItem(
        prose === undefined
          ? item
          : { ...item, template: prose.why, caveatsTemplate: prose.caveats },
        known,
      );
      if (prose === undefined) {
        fromTemplate += 1;
      }
      results.push({
        rank: row.rank,
        score: row.score,
        score_breakdown: row.score_breakdown,
        evidence_completeness: row.evidence_completeness,
        skill: item.skill,
        explanation: explanation.explanation,
        flags: withRepairedFlag(explanation.flags, prose?.repaired === true),
        // O `caveats` do agente manda; sem ele, vale o aviso de evidência
        // incompleta do template (regra 3: a lacuna nunca fica invisível).
          // O `caveats` ja vem RESOLVIDO do `explainItem` (que prefere o
          // `caveatsTemplate` do agente e cai no aviso de evidencia incompleta
          // quando ele falta). Republicar `prose.caveats` aqui descartava a
          // resolucao e mandava `{{skill:<id>}}` cru para a tela - HIGH da #42.
          caveats: explanation.caveats,
      });
    }

    const warnings: string[] = [];
    if (results.length === 0) {
      // Lista vazia é um estado explicado, nunca um branco silencioso (regra 7).
      warnings.push(SEARCH_WARNINGS.noResults);
    } else if (fromTemplate > 0) {
      // D-C: pelo menos um item saiu do template determinístico — o aviso existe
      // só quando houve fallback, nunca numa resposta 100% do agente.
      warnings.push(SEARCH_WARNINGS.explanationFromTemplate);
    }
    if (staleWarning !== null) {
      warnings.push(staleWarning);
    }

    return {
      results,
      recommendation: buildRecommendation(items, known, explained.recommendation),
      warnings,
      explainStatus: explained.status,
    };
  }

  /**
   * Passo 7 (§6.5): pede a prosa à porta `explain` e devolve o que ela validou.
   *
   * Nada do que sai daqui é publicado sem passar por `explainItem` — este método
   * só escolhe **o que** mandar e **se** vale mandar.
   */
  private async explainRanked(
    query: string,
    items: readonly ExplanationItem[],
    intent: Intent,
    budget: ExplainBudget | null,
  ): Promise<{
    status: LlmStatus | null;
    items: ReadonlyMap<string, ExplainedProse>;
    recommendation: ExplainedProse | null;
  }> {
    const skipped = { status: null, items: new Map<string, ExplainedProse>(), recommendation: null };
    const [rank1] = items;
    // Sem candidato não há o que explicar; sem orçamento/intenção confiável, o
    // passo não é tentado e `explain_status` fica `null` (ausência, não falha).
    if (budget === null || !budget.attempt || rank1 === undefined) {
      return skipped;
    }

    // O enriquecimento do rank 1 (`catalog.detail`) faz I/O: se ele falhar, a
    // busca NAO pode morrer com 500 - o passo 7 e opcional por contrato (7.4).
    // Antes esta consulta ficava fora do try e um erro nela derrubava a resposta
    // inteira (achado MEDIUM do parecer da #42).
    let candidates: readonly ExplainCandidate[];
    try {
      candidates = await this.explainCandidates(items, rank1);
    } catch {
      return { status: 'unavailable', items: new Map(), recommendation: null };
    }

    const request: ExplainRequest = {
      query,
      intent,
      candidates,
      catalog_snapshot: budget.catalogSnapshot,
      deadlineAtMs: budget.deadlineAtMs,
    };

    let result: ExplainResult;
    try {
      result = await this.explain.explain(request);
    } catch {
      // §7.4: a busca nunca morre por causa da LLM. O cliente real devolve
      // `unavailable` em vez de lançar, mas o serviço não pode depender de a porta
      // ser bem-comportada: um erro solto aqui derrubaria a resposta inteira.
      return { status: 'unavailable', items: new Map(), recommendation: null };
    }

    const prose = new Map<string, ExplainedProse>();
    for (const item of result.items) {
      prose.set(item.skill_id, {
        skill_id: item.skill_id,
        why: item.why,
        caveats: item.caveats,
        repaired: item.repaired,
      });
    }
    return {
      status: result.status,
      items: prose,
      recommendation:
        result.recommendation === null
          ? null
          : {
              skill_id: result.recommendation.skill_id,
              why: result.recommendation.why,
              caveats: null,
              repaired: result.recommendation.repaired,
            },
    };
  }

  /**
   * Candidatos na forma que o prompt consome (§6.5).
   *
   * `summary` e `skill_md_excerpt` vão **só do rank 1**: é ele que informa a
   * decisão, e repetir o trecho de cada item somaria ~1,6k tokens por busca.
   */
  private async explainCandidates(
    items: readonly ExplanationItem[],
    rank1: ExplanationItem,
  ): Promise<readonly ExplainCandidate[]> {
    const evidence = await this.rankOneEvidence(rank1.skill.skill_id);
    return items.map((item, index) => ({
      skill_id: item.skill.skill_id,
      name: item.skill.name,
      category: item.skill.category,
      stars: item.skill.stars,
      installs: item.skill.installs,
      // Dado ausente é `null`, nunca zero (regra 3); o prompt mostra `n/a`.
      vulnerability_count: item.skill.vulnerability_count,
      summary: index === 0 ? evidence.summary : null,
      skill_md_excerpt: index === 0 ? evidence.skill_md_excerpt : null,
    }));
  }

  /**
   * `summary`/`skill_md_excerpt` do rank 1 (issue #42, §7.5).
   *
   * O recuperador devolve `SkillSummary`, que não carrega os dois campos — o
   * detalhe é a única fonte deles. Uma consulta por busca, só para o topo.
   */
  private async rankOneEvidence(
    skillId: string,
  ): Promise<{ summary: string | null; skill_md_excerpt: string | null }> {
    const id = decodeSkillId(skillId);
    if (id === null) {
      return { summary: null, skill_md_excerpt: null };
    }
    const detail = await this.catalog.detail(id);
    return {
      summary: detail?.summary ?? null,
      skill_md_excerpt: detail?.skill_md_excerpt ?? null,
    };
  }

  /**
   * Intenção do passo de LLM; o parser já devolve o fallback lexical quando pode.
   *
   * O `deadlineAtMs` é o **mesmo** que a explicação vai receber: é ele que faz o
   * teto valer para a soma dos dois passos, não para cada um.
   */
  private parseIntent(
    query: string,
    categories: readonly CategoryItem[],
    deadlineAtMs: number,
  ): Promise<IntentParserResult> {
    return this.parser.parse(
      query,
      categories.map((category) => category.slug),
      { deadlineAtMs },
    );
  }

  /** Instante em que o orçamento somado dos passos de LLM expira (§6.5). */
  private llmDeadlineAt(): number {
    // `LLM_TOTAL_DEADLINE_MS` é o teto do conjunto; o `??` cobre contextos que
    // montam `env` parcial (dublês de teste) e nunca deixa o prazo virar `NaN`.
    const totalMs = this.config.env.llmTotalDeadlineMs ?? DEFAULT_LLM_TOTAL_DEADLINE_MS;
    return Date.now() + totalMs;
  }

  /** `llm_calls_total{status}` (D-F): o status é o do contrato, não um rótulo novo. */
  private observeLlmCall(status: LlmStatus): void {
    this.metrics?.observeLlmCall(status);
  }

  /** Pesos do ranking vêm da configuração (§6.4), nunca da intenção. */
  private weights(): RankingWeights {
    return {
      stars: this.config.env.rankWStars,
      vulnerabilities: this.config.env.rankWVulns,
      installs: this.config.env.rankWInstalls,
    };
  }
}

/** Milissegundos inteiros desde `startedAt` (`latency_ms`). */
function elapsedMs(startedAt: bigint): number {
  return Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
}

/**
 * Prosa validada pela porta `explain`, ainda com os placeholders do §6.5.
 *
 * Ela **não** é texto de resposta: o único caminho até `results[].explanation` e
 * `recommendation.text` é `explainItem` (issue #42).
 */
interface ExplainedProse {
  readonly skill_id: string;
  readonly why: string;
  readonly caveats: string | null;
  readonly repaired: boolean;
}

/** Acrescenta `explanation_repaired` sem duplicar a flag já vinda do template (§5.3). */
function withRepairedFlag(flags: readonly string[], repaired: boolean): string[] {
  if (!repaired || flags.includes(EXPLANATION_REPAIRED_FLAG)) {
    return [...flags];
  }
  return [...flags, EXPLANATION_REPAIRED_FLAG];
}

/**
 * Recomendação da resposta (§5.3).
 *
 * A prosa do agente só vale quando ela destaca o **rank 1 desta** resposta; o
 * `skill_id` é revalidado aqui antes de responder porque o cache de explicação
 * pode devolver a prosa de uma ordem antiga (US-05 AC1: o destaque é o topo).
 * Em qualquer outro caso, o texto determinístico de `recommend` responde.
 */
function buildRecommendation(
  items: readonly ExplanationItem[],
  known: ReadonlyMap<string, string>,
  prose: ExplainedProse | null,
): Recommendation | null {
  const [first] = items;
  if (first === undefined) {
    return null;
  }
  if (prose === null || prose.skill_id !== first.skill.skill_id) {
    return recommend(items);
  }
  // Mesmo caminho de `explainItem`: placeholder resolvido, nome escapado e teto.
  const { explanation } = explainItem({ ...first, template: prose.why }, known);
  return { skill_id: first.skill.skill_id, text: explanation };
}

/**
 * Termos que vão ao `tsquery` do catálogo (issue #40).
 *
 * `keywordsEn` é o que a intenção extraiu em inglês — o `search_doc` é indexado
 * em inglês. Ausente ou vazio (provedor `disabled`, intenção reparada), usa as
 * `keywords` da própria consulta: é a mesma regra de `parseIntentPayload`, e ela
 * garante que o recuperador nunca receba lista vazia nem derrube a busca. O
 * ranking não é afetado: `keywords` só escolhe **quem** entra na lista.
 */
function searchKeywords(parsed: IntentParserResult): readonly string[] {
  const english = parsed.keywordsEn ?? [];
  return english.length > 0 ? english : parsed.intent.keywords;
}


/** `search_request.status` (§4.1): a lacuna e a degradação são estados distintos. */
function storedStatus(resultCount: number, degraded: boolean): StoredSearchStatus {
  if (resultCount === 0) {
    return 'empty';
  }
  return degraded ? 'degraded' : 'ok';
}

/** `SkillSummary.skill_id` -> `result_ids` (D-B: o banco fala `bigint`). */
function toBigIntIds(results: readonly ResultItem[]): bigint[] {
  return results
    .map((item) => decodeSkillId(item.skill.skill_id))
    .filter((id): id is bigint => id !== null);
}

function unknownCategory(slug: string): ApiError {
  return new ApiError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    ERROR_CODES.VALIDATION_ERROR,
    `Unknown category: ${slug}.`,
    { reason: VALIDATION_REASON.unknownCategory, fields: ['category'] },
  );
}

function cacheEmpty(): ApiError {
  return new ApiError(
    HttpStatus.SERVICE_UNAVAILABLE,
    ERROR_CODES.SOURCE_UNAVAILABLE,
    'The catalog has not been ingested yet.',
    { reason: SOURCE_UNAVAILABLE_REASON.cacheEmpty },
  );
}
