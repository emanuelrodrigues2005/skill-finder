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

/** `status`: ok | timeout | http_error | invalid_json | invalid_ids | disabled. */
export interface Llm {
  status: string;
  model: string;
  cached: boolean;
  tokens: LlmTokens | null;
}

export type DegradedReason = "source_stale" | "llm_unavailable";

export interface SearchData {
  source: string;
  catalog_snapshot: string | null;
  age_seconds: number | null;
  degraded: boolean;
  degraded_reason: DegradedReason | null;
}

export interface ScoreBreakdown {
  stars: number | null;
  vulnerabilities: number | null;
  installs: number | null;
  missing_fields: number;
  penalty_factor: number;
}

/** Marca de quanto dado real existe para o item (spec §5.5). Campo ausente vira `n/a` na UI. */
export interface EvidenceCompleteness {
  missing_fields: number;
  penalty_factor: number;
}

export interface SkillSummary {
  skill_id: string;
  name: string;
  source_url: string;
  category: string;
  stars: number | null;
  installs: number | null;
  vulnerability_count: number | null;
  security_status: string;
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
  data_snapshot: string | null;
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
}

export interface ErrorEnvelope {
  request_id: string;
  error: {
    code: string;
    message: string;
    details: Record<string, unknown>;
    retry_after_seconds?: number;
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
