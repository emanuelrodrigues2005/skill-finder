import type {
  CategoriesResponse,
  ErrorEnvelope,
  ResultItem,
  SearchResponse,
  SkillDetailResponse,
  SkillSummary,
} from "../../types";

/**
 * Fixtures do contrato v0 (`openapi.yaml`) para a suíte do frontend (issue #29).
 *
 * `request_id` e `search_id` são **diferentes de propósito**: o permalink e o
 * `GET /api/v1/searches/{request_id}` usam o primeiro; um teste que os trocasse ficaria verde
 * com a tela errada.
 */

export const REQUEST_ID = "req_01hq9x2f7k3m";
export const SEARCH_ID = "srch_7c1d4c0a9b21";

/**
 * Prefixo do texto que o **servidor** manda em `error.message`. A interface nunca renderiza esse
 * texto (ela decide por `error.code`, `docs/app/02-arquitetura.md` §5.5), então todo teste de
 * falha confere `queryByText(SERVER_MESSAGE) === null`: se ele aparecer, o teste pegou a tela
 * passando pelo motivo errado.
 */
export const SERVER_MESSAGE = "server said:";

const pdfSkill: SkillSummary = {
  skill_id: "skl_pdf_extract",
  name: "pdf-extract",
  source_url: "https://skills.sh/skills/pdf-extract",
  category: "documents",
  stars: 1820,
  installs: 9400,
  vulnerability_count: 0,
  security_status: "ok",
  skill_md_present: true,
};

const tableSkill: SkillSummary = {
  skill_id: "skl_table_reader",
  name: "table-reader",
  source_url: "https://skills.sh/skills/table-reader",
  category: "documents",
  stars: 640,
  installs: 2100,
  vulnerability_count: 2,
  security_status: "warn",
  skill_md_present: true,
};

/** Item completo: nenhuma lacuna de evidência, então o selo é `evidence complete`. */
export const topResult = {
  rank: 1,
  score: 0.8734,
  score_breakdown: { stars: 0.91, vulnerabilities: 1, installs: 0.84, missing_fields: 0, penalty_factor: 1 },
  evidence_completeness: { missing_fields: 0, penalty_factor: 1 },
  skill: pdfSkill,
  explanation: "extracts text from scanned PDFs with a table-aware layout pass",
  flags: [],
  caveats: null,
} satisfies ResultItem;

/** Item com ressalva e `flags`: exercita as três linhas de razão do cartão. */
export const secondResult = {
  rank: 2,
  score: 0.6118,
  score_breakdown: { stars: 0.42, vulnerabilities: 0.5, installs: 0.37, missing_fields: 0, penalty_factor: 1 },
  evidence_completeness: { missing_fields: 0, penalty_factor: 1 },
  skill: tableSkill,
  explanation: "reads tables out of PDFs, but only with a text layer",
  flags: ["security_warn"],
  caveats: "two advisories were reported against this repository",
} satisfies ResultItem;

/** Resposta canônica de `POST /api/v1/search` e de `GET /api/v1/searches/{request_id}`. */
export const searchResponse = {
  request_id: REQUEST_ID,
  search_id: SEARCH_ID,
  intent: {
    category: "documents",
    keywords: ["pdf", "extract", "table"],
    filters: {},
    language: "en",
    confidence: 0.87,
  },
    llm: {
      status: "ok",
      model: "llm-test-1",
      cached: false,
      tokens: { prompt: 812, completion: 96 },
      // Passo 7 do contrato (issue #42): `required` + `nullable`.
      explain_status: "ok",
    },
  data: {
    source: "skills.sh",
    catalog_snapshot: "2026-11-15T03:00:00Z",
    age_seconds: 3600,
    degraded: false,
    degraded_reason: null,
  },
  results: [topResult, secondResult],
  recommendation: { skill_id: "skl_pdf_extract", text: "Start with pdf-extract: it handles scanned PDFs." },
  warnings: [],
} satisfies SearchResponse;

/** Nenhum candidato: a tela precisa explicar o vazio, não mostrar lista em branco (regra 7). */
export const emptySearchResponse = {
  ...searchResponse,
  results: [],
  recommendation: null,
  warnings: [],
} satisfies SearchResponse;

/** Catálogo velho: faixa de degradação com motivo e idade derivada de `age_seconds`. */
export const degradedSearchResponse = {
  ...searchResponse,
  llm: { status: "disabled", model: null, cached: false, tokens: null, explain_status: null },
  data: {
    source: "skills.sh",
    catalog_snapshot: "2026-11-14T03:00:00Z",
    age_seconds: 7200,
    degraded: true,
    degraded_reason: "source_stale",
  },
  results: [],
  recommendation: null,
  warnings: ["the catalog snapshot is older than the ingestion window"],
} satisfies SearchResponse;

/**
 * Item com todos os campos opcionais ausentes (`null`) e `skill_md_present: false`: cada um
 * precisa sair como `n/a` na tela, nunca como `0` (AGENTS.md, regra 3).
 */
export const nullFieldsResult = {
  rank: 1,
  score: 0.51,
  score_breakdown: { stars: 0, vulnerabilities: 1, installs: 0, missing_fields: 3, penalty_factor: 0.82 },
  evidence_completeness: { missing_fields: 3, penalty_factor: 0.82 },
  skill: {
    skill_id: "skl_sparse_meta",
    name: "sparse-skill",
    source_url: null,
    category: null,
    stars: null,
    installs: null,
    vulnerability_count: null,
    security_status: "unknown",
    skill_md_present: false,
  },
  explanation: "matched on keywords only",
  flags: [],
  caveats: null,
} satisfies ResultItem;

/** Resposta com um único item incompleto — o caso `n/a` da tela de resultados. */
export const nullFieldsSearchResponse = {
  ...searchResponse,
  results: [nullFieldsResult],
  recommendation: null,
  warnings: [],
} satisfies SearchResponse;

/**
 * Busca vazia que **disparou** o enriquecimento ao vivo (fase 1 da auditoria de latência).
 *
 * `warnings` é `string[]` livre no contrato e carrega **tokens** (`no_results`,
 * `source_stale`, `catalog_enriching`): a tela traduz cada um (AGENTS.md, regra 6) e
 * mantém o token visível como identificador de diagnóstico.
 */
export const enrichingSearchResponse = {
  ...searchResponse,
  llm: { status: "disabled", model: null, cached: false, tokens: null, explain_status: null },
  data: {
    source: "skills.sh",
    catalog_snapshot: "2026-11-14T03:00:00Z",
    age_seconds: 50000,
    degraded: true,
    degraded_reason: "source_stale",
  },
  results: [],
  recommendation: null,
  warnings: ["no_results", "source_stale", "catalog_enriching"],
} satisfies SearchResponse;

/** `GET /api/v1/categories`: as duas categorias que a tela de busca mostra no `<select>`. */
export const categoriesFixture = {
  request_id: REQUEST_ID,
  data: [
    { slug: "documents", label_en: "Documents", skill_count: 42 },
    { slug: "testing", label_en: "Testing", skill_count: 17 },
  ],
  data_snapshot: "2026-11-15T03:00:00Z",
} satisfies CategoriesResponse;

/**
 * `GET /api/v1/skills/{skill_id}`: `source_url` http(s) vira link externo com `rel` de
 * segurança; `repo_url` ausente é `n/a`; `stars`/`installs`/`vulnerabilities` ausentes são `n/a`.
 */
export const skillDetailFixture = {
  request_id: REQUEST_ID,
  data: {
    skill_id: "skl_pdf_extract",
    name: "pdf-extract",
    summary: "Extracts text and tables from PDF documents.",
    source_url: "https://skills.sh/skills/pdf-extract",
    repo_url: null,
    category: null,
    stars: null,
    installs: null,
    vulnerability_count: null,
    security_status: "unknown",
    skill_md_present: true,
    skill_md_excerpt: "Extract the text layer first, then run the table pass.",
    data_snapshot: "2026-11-15T03:00:00.000Z",
  },
} satisfies SkillDetailResponse;

export interface ErrorEnvelopeOptions {
  /** `null` reproduz um erro sem `request_id` (ex.: falha antes do handler). */
  requestId?: string | null;
  details?: Record<string, unknown>;
  retryAfterSeconds?: number | null;
}

/**
 * Envelope de erro no formato do contrato. O `message` é sempre o texto do "servidor", com o
 * prefixo `SERVER_MESSAGE` — deliberadamente diferente de qualquer mensagem da interface.
 */
export function errorEnvelope(code: string, options: ErrorEnvelopeOptions = {}): ErrorEnvelope {
  const envelope: ErrorEnvelope = {
    request_id: options.requestId === undefined ? REQUEST_ID : options.requestId,
    error: {
      code,
      message: `${SERVER_MESSAGE} ${code} — this sentence belongs to the server and must never reach the UI.`,
      details: options.details ?? {},
    },
  };
  if (options.retryAfterSeconds !== undefined) {
    envelope.error.retry_after_seconds = options.retryAfterSeconds;
  }
  return envelope;
}
