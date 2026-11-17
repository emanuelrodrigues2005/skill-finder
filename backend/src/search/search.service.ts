/**
 * Orquestração da busca (`docs/app/02-arquitetura.md` §5.2–§5.4, §6, §7.4).
 *
 * O caminho é sempre o mesmo, e nenhuma etapa conhece a implementação da outra:
 *
 *   categoria (D-A) -> snapshot do cache (503) -> intenção (LLM ou fallback)
 *   -> candidatos -> ranking determinístico -> explicação (D-C) -> persistência
 *
 * Invariantes que valem aqui dentro:
 * - o ranking é do servidor (regra 1): a LLM só entrega a `Intent`, e a ordem
 *   sai de `src/ranking`, uma função pura;
 * - dado ausente é `null`, nunca zero (regra 3): a lacuna vira
 *   `evidence_completeness`/`caveats`, não um `0` inventado;
 * - degradação é visível (regra 7): catálogo velho ou LLM fora do ar mudam
 *   `data.degraded` e `warnings`, nunca a resposta em silêncio;
 * - o `request_id` da resposta é cunhado aqui (C4), não vem do header.
 */
import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';

import { ERROR_CODES } from '../common/errors/error-codes';
import { ApiError } from '../common/errors/http-exception.filter';
import { MetricsService } from '../common/metrics/metrics.service';
import { AppConfigService } from '../config/config.module';
import type { CategoryItem, SkillDetail, SkillSummary } from '../contract/dto/catalog.dto';
import type { Intent, LlmStatus, SearchResponse } from '../contract/dto/search-response.dto';
import type { ResultItem } from '../contract/dto/result-item.dto';
import { resolveDegradation } from '../llm/degradation';
import { INTENT_PARSER } from '../llm/llm.module';
import type { IntentParser, IntentParserResult } from '../llm/intent-parser';
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
import { explainItem, recommend, type ExplanationItem } from './explanation';
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

    // D-A: a categoria é um enum fechado; validar antes do cache evita pagar
    // uma consulta de recuperação para responder 422 depois.
    if (input.category !== null && !(await this.catalog.categoryExists(input.category))) {
      throw unknownCategory(input.category);
    }

    const snapshot = await this.catalog.snapshot();
    if (snapshot === null) {
      throw cacheEmpty();
    }

    // O vocabulário de categorias é o do catálogo do momento: a intenção que
    // citar uma categoria fora dele é reparada por `parseIntentPayload` (§6.3).
    const categories = await this.catalog.listCategories();
    const parsed = await this.parseIntent(input.query, categories);
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
      category: input.category,
      limit: Math.max(input.limit, CANDIDATE_POOL_SIZE),
    });
    const { results, recommendation, warnings } = this.rankAndExplain(
      candidates,
      parsed.intent,
      input.limit,
      // `source_stale` fala do **frescor do snapshot**, não da degradação:
      // `resolveDegradation` também marca `disabled`/`unavailable`/`invalid_ids`/
      // `low_confidence`, então amarrar o aviso em `degradation.degraded` diria
      // "catálogo velho" com snapshot fresco (o default de dev/CI, sem LLM).
      ageMs > SOURCE_STALE_AFTER_MS ? SEARCH_WARNINGS.sourceStale : null,
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
      },
      data: {
        degraded: degradation.degraded,
        degraded_reason: degradation.degraded_reason,
        source: 'cache',
        catalog_snapshot: snapshot.toISOString(),
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

    const { results, recommendation, warnings } = this.rankAndExplain(
      storedOrder,
      row.intent,
      storedOrder.length,
      // Mesmo critério da busca: frescor do snapshot, nunca o status da LLM.
      ageMs > SOURCE_STALE_AFTER_MS ? SEARCH_WARNINGS.sourceStale : null,
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

  /** Ranqueia, explica e monta o envelope comum a busca e permalink. */
  private rankAndExplain(
    candidates: readonly SkillSummary[],
    intent: Intent,
    limit: number,
    staleWarning: string | null,
  ): {
    results: ResultItem[];
    recommendation: SearchResponse['recommendation'];
    warnings: string[];
  } {
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
    for (const row of ranked) {
      const skill = bySkillId.get(row.skill_id);
      if (skill !== undefined) {
        known.set(row.skill_id, skill.name);
      }
    }

    const items: ExplanationItem[] = [];
    const results: ResultItem[] = [];
    for (const row of ranked) {
      const skill = bySkillId.get(row.skill_id);
      if (skill === undefined) {
        continue;
      }
      const item: ExplanationItem = {
        skill,
        score_breakdown: row.score_breakdown,
        evidence_completeness: row.evidence_completeness,
      };
      const explanation = explainItem(item, known);
      items.push(item);
      results.push({
        rank: row.rank,
        score: row.score,
        score_breakdown: row.score_breakdown,
        evidence_completeness: row.evidence_completeness,
        skill,
        explanation: explanation.explanation,
        flags: explanation.flags,
        caveats: explanation.caveats,
      });
    }

    const warnings: string[] = [];
    if (results.length === 0) {
      // Lista vazia é um estado explicado, nunca um branco silencioso (regra 7).
      warnings.push(SEARCH_WARNINGS.noResults);
    } else {
      // D-C: sem `explain` na porta da LLM, o texto sai do template determinístico.
      warnings.push(SEARCH_WARNINGS.explanationFromTemplate);
    }
    if (staleWarning !== null) {
      warnings.push(staleWarning);
    }

    return {
      results,
      recommendation: recommend(items),
      warnings,
    };
  }

  /** Intenção do passo de LLM; o parser já devolve o fallback lexical quando pode. */
  private parseIntent(
    query: string,
    categories: readonly CategoryItem[],
  ): Promise<IntentParserResult> {
    return this.parser.parse(
      query,
      categories.map((category) => category.slug),
    );
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
