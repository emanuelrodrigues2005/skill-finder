import type {
  CategoriesResponse,
  Category,
  ErrorEnvelope,
  SearchResponse,
  SkillDetail,
  SkillListResponse,
} from "./types";
import { SEARCH_LIMIT_DEFAULT } from "./types";

/**
 * Cliente da API v0 (`/api/v1`). `baseURL` é relativo: o navegador só conhece o
 * próprio host e nunca vê chave de LLM (ver AGENTS.md, regra 4).
 */
export const API_BASE = "/api/v1";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;

  constructor(status: number, code: string, message: string, requestId: string | null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

async function parseError(response: Response): Promise<ApiError> {
  let envelope: ErrorEnvelope | null = null;
  try {
    envelope = (await response.json()) as ErrorEnvelope;
  } catch {
    // corpo não-JSON: mantém a mensagem genérica
  }
  return new ApiError(
    response.status,
    envelope?.error?.code ?? "INTERNAL",
    envelope?.error?.message ?? "request failed",
    envelope?.request_id ?? response.headers.get("x-request-id"),
  );
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    throw await parseError(response);
  }
  return (await response.json()) as T;
}

export function searchSkills(
  query: string,
  category: string | null,
  limit: number = SEARCH_LIMIT_DEFAULT,
): Promise<SearchResponse> {
  return requestJson<SearchResponse>("/search", {
    method: "POST",
    body: JSON.stringify({ query, category, limit }),
  });
}

export function getSearch(requestId: string): Promise<SearchResponse> {
  return requestJson<SearchResponse>(`/searches/${encodeURIComponent(requestId)}`);
}

export function getCategories(): Promise<CategoriesResponse> {
  return requestJson<CategoriesResponse>("/categories");
}

export interface SkillListParams {
  category?: string | null;
  sortBy?: "stars" | "installs";
  page?: number;
  pageSize?: number;
}

export function getSkills(params: SkillListParams = {}): Promise<SkillListResponse> {
  const search = new URLSearchParams();
  if (params.category) search.set("category", params.category);
  if (params.sortBy) search.set("sort_by", params.sortBy);
  if (params.page) search.set("page", String(params.page));
  if (params.pageSize) search.set("page_size", String(params.pageSize));
  const suffix = search.toString() ? `?${search.toString()}` : "";
  return requestJson<SkillListResponse>(`/skills${suffix}`);
}

export function getSkill(skillId: string): Promise<SkillDetail> {
  return requestJson<SkillDetail>(`/skills/${encodeURIComponent(skillId)}`);
}

// ---------------------------------------------------------------------------
// Dados mockados em memória.
// TODO(F2.6): apagar os MOCK_* e as loadMock* quando `/api/v1/search`,
// `/categories` e `/skills/{id}` existirem; as telas passam a chamar as funções acima.
// ---------------------------------------------------------------------------

export const MOCK_CATEGORIES: Category[] = [
  { slug: "backend", label_en: "Backend", skill_count: 142 },
  { slug: "frontend", label_en: "Frontend", skill_count: 98 },
  { slug: "testing", label_en: "Testing", skill_count: 61 },
  { slug: "devops", label_en: "DevOps", skill_count: 44 },
  { slug: "documentation", label_en: "Documentation", skill_count: 27 },
];

const SKILL_SECURITY_REVIEW = "sk_01jcv8y6q4abcdefghij";
const SKILL_LINT_BRIDGE = "sk_01jcv8y6q5klmnopqrst";
const SKILL_CHECKLIST = "sk_01jcv8y6q6uvwxyz0123";

export const MOCK_SEARCH: SearchResponse = {
  request_id: "req_01JCV8Y6Q4",
  search_id: "b0d1f3a2-7c1e-4a55-9f0e-2d4a1c6b8e11",
  intent: {
    category: "backend",
    keywords: ["python", "security", "code review", "pull request"],
    filters: { exclude_with_vulnerabilities: false },
    language: "en",
    confidence: 0.82,
  },
  llm: {
    status: "timeout",
    model: "deepseek-v4.1-flash",
    cached: false,
    tokens: null,
  },
  data: {
    source: "cache",
    catalog_snapshot: "2026-11-14T18:00:00Z",
    age_seconds: 3600,
    degraded: true,
    degraded_reason: "llm_unavailable",
  },
  results: [
    {
      rank: 1,
      score: 0.8053,
      score_breakdown: {
        stars: 0.716,
        vulnerabilities: 1,
        installs: 0.7363,
        missing_fields: 0,
        penalty_factor: 1,
      },
      evidence_completeness: { missing_fields: 0, penalty_factor: 1 },
      skill: {
        skill_id: SKILL_SECURITY_REVIEW,
        name: "python-security-review",
        source_url: "/skills/python-security-review",
        category: "backend",
        stars: 1200,
        installs: 8000,
        vulnerability_count: 0,
        security_status: "ok",
        skill_md_present: true,
      },
      explanation:
        "Targets Python services and reports findings directly on the pull request. It is the safest of the returned options, with no reported vulnerabilities.",
      flags: [],
    },
    {
      rank: 2,
      score: 0.6171,
      score_breakdown: {
        stars: 0.6914,
        vulnerabilities: 0.8,
        installs: 0.5,
        missing_fields: 1,
        penalty_factor: 0.9,
      },
      evidence_completeness: { missing_fields: 1, penalty_factor: 0.9 },
      skill: {
        skill_id: SKILL_LINT_BRIDGE,
        name: "python-lint-bridge",
        source_url: "/skills/python-lint-bridge",
        category: "backend",
        stars: 940,
        installs: null,
        vulnerability_count: 1,
        security_status: "warn",
        skill_md_present: true,
      },
      explanation: "Runs the configured linter over the changed files before review.",
      flags: ["evidence_incomplete"],
    },
    {
      rank: 3,
      score: 0.3937,
      score_breakdown: {
        stars: 0.4843,
        vulnerabilities: 0.5,
        installs: 0.5,
        missing_fields: 2,
        penalty_factor: 0.8,
      },
      evidence_completeness: { missing_fields: 2, penalty_factor: 0.8 },
      skill: {
        skill_id: SKILL_CHECKLIST,
        name: "review-checklist",
        source_url: "/skills/review-checklist",
        category: "testing",
        stars: 120,
        installs: null,
        vulnerability_count: null,
        security_status: "unknown",
        skill_md_present: false,
      },
      explanation: "Lightweight checklist runner for pull requests.",
      flags: ["evidence_incomplete"],
    },
  ],
  recommendation: {
    skill_id: SKILL_SECURITY_REVIEW,
    text: "Start with python-security-review: it is the only Python security-review skill in the catalog with no reported vulnerabilities.",
  },
  warnings: ["llm_unavailable: intent came from the keyword fallback"],
};

export const MOCK_SKILLS: Record<string, SkillDetail> = {
  [SKILL_SECURITY_REVIEW]: {
    skill_id: SKILL_SECURITY_REVIEW,
    name: "python-security-review",
    source_url: "/skills/python-security-review",
    category: "backend",
    stars: 1200,
    installs: 8000,
    vulnerability_count: 0,
    security_status: "ok",
    skill_md_present: true,
    summary: "Reviews Python pull requests for security problems.",
    repo_url: "/repos/python-security-review",
    skill_md_excerpt:
      "Use this skill when a pull request changes Python code that handles input, authentication or secrets. Read the diff, then list risky patterns before style nits.",
  },
  [SKILL_LINT_BRIDGE]: {
    skill_id: SKILL_LINT_BRIDGE,
    name: "python-lint-bridge",
    source_url: "/skills/python-lint-bridge",
    category: "backend",
    stars: 940,
    installs: null,
    vulnerability_count: 1,
    security_status: "warn",
    skill_md_present: true,
    summary: "Runs a linter over changed files and summarises findings.",
    repo_url: null,
    skill_md_excerpt: "Run the configured linter, then summarise findings in three bullets.",
  },
  [SKILL_CHECKLIST]: {
    skill_id: SKILL_CHECKLIST,
    name: "review-checklist",
    source_url: "/skills/review-checklist",
    category: "testing",
    stars: 120,
    installs: null,
    vulnerability_count: null,
    security_status: "unknown",
    skill_md_present: false,
    summary: null,
    repo_url: null,
    skill_md_excerpt: null,
  },
};

export function loadMockSearch(): Promise<SearchResponse> {
  return Promise.resolve(MOCK_SEARCH);
}

export function loadMockCategories(): Promise<Category[]> {
  return Promise.resolve(MOCK_CATEGORIES);
}

export function loadMockSkill(skillId: string): Promise<SkillDetail> {
  const fallback = MOCK_SKILLS[SKILL_SECURITY_REVIEW];
  return Promise.resolve(MOCK_SKILLS[skillId] ?? fallback);
}
