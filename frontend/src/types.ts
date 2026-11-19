/** Contrato v0 — `docs/app/02-arquitetura.md` §5. Dado ausente é `null`, nunca zero. */

export interface Intent {
  category: string | null;
  keywords: string[];
  filters: Record<string, unknown>;
  language: string;
  confidence: number;
}

export interface LlmTokens {
  prompt: number;
  completion: number;
}

/** `openapi.yaml` › components.schemas.LlmInfo.properties.status.enum — exactly these seven. */
export type LlmStatus =
  | "ok"
  | "cached"
  | "repaired"
  | "invalid_ids"
  | "low_confidence"
  | "unavailable"
  | "disabled";

export interface Llm {
  status: LlmStatus;
  /** null without a provider call. */
  model: string | null;
  cached: boolean;
  tokens: LlmTokens | null;
  /**
   * Desfecho do passo de explicacao (issue #42). `null` = nao tentado
   * (replay, LLM desligada, confianca baixa). O contrato o marca como
   * `required` + `nullable` desde a #39; sem ele o cliente gerado do
   * `openapi.yaml` recebia um corpo invalido e a tela nao distinguia
   * prosa do agente de texto de template.
   */
  explain_status: LlmStatus | null;
}

export type DegradedReason = "source_stale" | "llm_unavailable";

export interface SearchData {
  source: string;
  catalog_snapshot: string;
  age_seconds: number;
  degraded: boolean;
  degraded_reason: DegradedReason | null;
}

export interface ScoreBreakdown {
  stars: number;
  vulnerabilities: number;
  installs: number;
  missing_fields: number;
  penalty_factor: number;
}

/** Marca de quanto dado real existe para o item (spec §5.5). Campo ausente vira `n/a` na UI. */
export interface EvidenceCompleteness {
  missing_fields: number;
  penalty_factor: number;
}

/** `openapi.yaml` › components.schemas.SkillSummary.properties.security_status.enum — exactly four. */
export type SecurityStatus = "ok" | "warn" | "fail" | "unknown";

export interface SkillSummary {
  skill_id: string;
  name: string;
  source_url: string | null;
  category: string | null;
  stars: number | null;
  installs: number | null;
  vulnerability_count: number | null;
  security_status: SecurityStatus;
  skill_md_present: boolean;
}

export interface ResultItem {
  rank: number;
  score: number;
  score_breakdown: ScoreBreakdown;
  evidence_completeness: EvidenceCompleteness;
  skill: SkillSummary;
  explanation: string;
  flags: string[];
  caveats: string | null;
}

export interface Recommendation {
  skill_id: string;
  text: string;
}

export interface SearchResponse {
  request_id: string;
  search_id: string;
  intent: Intent;
  llm: Llm;
  data: SearchData;
  results: ResultItem[];
  recommendation: Recommendation | null;
  warnings: string[];
}

export interface Category {
  slug: string;
  label_en: string;
  skill_count: number;
}

export interface CategoriesResponse {
  request_id: string;
  data: Category[];
  data_snapshot: string;
}

export interface Pagination {
  page: number;
  page_size: number;
  total_items: number;
  total_pages: number;
}

export interface SkillListResponse {
  request_id: string;
  data: SkillSummary[];
  pagination: Pagination;
}

export interface SkillDetail extends SkillSummary {
  summary: string | null;
  repo_url: string | null;
  skill_md_excerpt: string | null;
  /** RFC 3339 (`date-time`) of the catalog snapshot; `null` when never ingested. */
  data_snapshot: string | null;
}

/** `openapi.yaml` › components.schemas.SkillDetailResponse — the envelope `getSkill` returns. */
export interface SkillDetailResponse {
  request_id: string;
  data: SkillDetail;
}

export interface ErrorEnvelope {
  request_id: string | null;
  error: {
    code: string;
    message: string;
    details: Record<string, unknown>;
    retry_after_seconds?: number | null;
  };
}

export interface SearchRequest {
  query: string;
  category: string | null;
  limit: number;
}

// Limites do contrato (§5.2).
export const QUERY_MIN_LENGTH = 3;
export const QUERY_MAX_LENGTH = 500;
export const SEARCH_LIMIT_DEFAULT = 5;
export const SEARCH_LIMIT_MAX = 20;
