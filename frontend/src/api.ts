import type {
  CategoriesResponse,
  ErrorEnvelope,
  SearchResponse,
  SkillDetailResponse,
  SkillListResponse,
} from "./types";
import { SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX } from "./types";

/**
 * Cliente da API v0 (`/api/v1`). `baseURL` é relativo: o navegador só conhece o
 * próprio host e nunca vê chave de LLM (ver AGENTS.md, regra 4).
 */
export const API_BASE = "/api/v1";

/** Teto de uma chamada. Sem isto, uma requisição pendurada deixa a tela em `LoadingState` para sempre. */
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Código **do cliente** para uma requisição que nunca foi respondida (timeout). Não existe no
 * enum `ErrorBody.code` do `openapi.yaml`: o servidor nunca o envia, o cliente o produz com
 * `status: 0`.
 */
export const TIMEOUT_CODE = "TIMEOUT";

const UNKNOWN_CODE_MESSAGE = "Something went wrong. Please try again.";

/**
 * `error.code` → mensagem exibida (inglês: AGENTS.md, regra 6). A tela decide por **código**,
 * nunca pelo texto do servidor (`docs/app/02-arquitetura.md` §5.5).
 *
 * Cobre os 12 códigos do enum `openapi.yaml` › `components.schemas.ErrorBody.properties.code`,
 * o código de cliente `TIMEOUT` e o alias `UNKNOWN_CATEGORY` (nomeado em
 * `docs/app/01-spec-produto.md` AC2 e no AC da issue #24; o contrato congelado o entrega como
 * `VALIDATION_ERROR`, então aqui ele só evita cair na mensagem genérica).
 */
const MESSAGE_BY_CODE: Readonly<Record<string, string>> = {
  BAD_REQUEST: "The request was invalid. Check the input and try again.",
  VALIDATION_ERROR: "Some fields are invalid. Check the search and try again.",
  UNKNOWN_CATEGORY: "That category does not exist. Pick one from the list.",
  UNAUTHORIZED: "You are not allowed to do that.",
  FORBIDDEN: "You are not allowed to do that.",
  NOT_FOUND: "We could not find what you asked for.",
  CONFLICT: "That operation is already running. Try again in a moment.",
  HISTORY_EXPIRED: "This search has expired. Start a new search.",
  RATE_LIMITED: "Too many requests.",
  LLM_BAD_RESPONSE: "The language model answer could not be used. Try again.",
  SOURCE_UNAVAILABLE: "The skill catalog is unavailable right now. Try again later.",
  NOT_READY: "The service is not ready yet. Try again in a moment.",
  INTERNAL: "Something went wrong on our side. Try again.",
  [TIMEOUT_CODE]: "The request took too long. Check your connection and try again.",
};

/**
 * Mensagem da interface para um `error.code`. Código desconhecido cai na genérica — nunca no
 * texto do servidor. `RATE_LIMITED` com `retryAfterSeconds` diz em quantos segundos tentar.
 */
export function messageForCode(code: string, retryAfterSeconds: number | null = null): string {
  const base = MESSAGE_BY_CODE[code] ?? UNKNOWN_CODE_MESSAGE;
  if (code === "RATE_LIMITED" && typeof retryAfterSeconds === "number" && retryAfterSeconds > 0) {
    const seconds = Math.trunc(retryAfterSeconds);
    return `${base} Try again in ${seconds} second${seconds === 1 ? "" : "s"}.`;
  }
  return base;
}

/** Campos opcionais do `ApiError` — o único lugar que constrói um é este módulo. */
export interface ApiErrorInit {
  status: number;
  code: string;
  requestId: string | null;
  retryAfterSeconds?: number | null;
  details?: Record<string, unknown>;
  serverMessage?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  /** `error.retry_after_seconds` — only meaningful on 429; `null` everywhere else. */
  readonly retryAfterSeconds: number | null;
  /**
   * `error.details` do envelope: `fields` no 422, `reason` no 503, `limit`/`window_seconds` no
   * 429, `run_id` no 409, `expires_at` no 410. Vazio quando não há detalhe.
   */
  readonly details: Record<string, unknown>;
  /**
   * Texto cru do servidor (`error.message`). **Só para log/diagnóstico** — a interface nunca
   * renderiza isto; `message` já é a mensagem do mapa de código.
   */
  readonly serverMessage: string;

  constructor(init: ApiErrorInit) {
    const retryAfterSeconds = init.retryAfterSeconds ?? null;
    super(messageForCode(init.code, retryAfterSeconds));
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.retryAfterSeconds = retryAfterSeconds;
    this.details = init.details ?? {};
    this.serverMessage = init.serverMessage ?? "";
  }
}

/** Category slug sent to the API: `null`, `""` and whitespace all mean "every category". */
function normaliseCategory(category: string | null | undefined): string | null {
  const trimmed = category?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/** `limit` is clamped to the contract range `[1, SEARCH_LIMIT_MAX]`; default `SEARCH_LIMIT_DEFAULT`. */
function clampSearchLimit(limit: number = SEARCH_LIMIT_DEFAULT): number {
  if (!Number.isFinite(limit)) return SEARCH_LIMIT_DEFAULT;
  return Math.min(SEARCH_LIMIT_MAX, Math.max(1, Math.trunc(limit)));
}

/** `page_size` do contrato: 1–100, default 20 (`docs/app/02-arquitetura.md` §5.6). */
export const SKILLS_PAGE_SIZE_DEFAULT = 20;
export const SKILLS_PAGE_SIZE_MAX = 100;

function clampPageSize(size: number = SKILLS_PAGE_SIZE_DEFAULT): number {
  if (!Number.isFinite(size)) return SKILLS_PAGE_SIZE_DEFAULT;
  return Math.min(SKILLS_PAGE_SIZE_MAX, Math.max(1, Math.trunc(size)));
}

/** `page` é 1-based no contrato; `0`, negativo e `NaN` caem em 1. */
function clampPage(page: number = 1): number {
  if (!Number.isFinite(page)) return 1;
  return Math.max(1, Math.trunc(page));
}

/**
 * `AbortSignal.timeout` rejeita com `DOMException` `TimeoutError`; um `AbortController` do
 * chamador rejeita com `AbortError`. Nos dois casos o servidor não respondeu a tempo.
 */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

async function parseError(response: Response): Promise<ApiError> {
  let envelope: ErrorEnvelope | null = null;
  try {
    envelope = (await response.json()) as ErrorEnvelope;
  } catch {
    // corpo não-JSON: fica no código padrão e a mensagem vem do mapa, nunca do texto
  }
  return new ApiError({
    status: response.status,
    code: envelope?.error?.code ?? "INTERNAL",
    requestId: envelope?.request_id ?? response.headers.get("x-request-id"),
    retryAfterSeconds: envelope?.error?.retry_after_seconds ?? null,
    details: envelope?.error?.details ?? {},
    serverMessage: envelope?.error?.message ?? "",
  });
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  // Timeout em toda chamada: um `signal` do chamador tem precedência.
  const signal = init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...init,
      signal,
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
  } catch (error) {
    if (isAbortError(error)) {
      // `status: 0` = o servidor não respondeu; `requestId` não existe porque não houve corpo.
      throw new ApiError({ status: 0, code: TIMEOUT_CODE, requestId: null });
    }
    throw error;
  }
}

export function searchSkills(
  query: string,
  category: string | null = null,
  limit: number = SEARCH_LIMIT_DEFAULT,
): Promise<SearchResponse> {
  return requestJson<SearchResponse>("/search", {
    method: "POST",
    body: JSON.stringify({ query, category: normaliseCategory(category), limit: clampSearchLimit(limit) }),
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
  sortBy?: "stars" | "installs" | "name";
  page?: number;
  pageSize?: number;
}

export function getSkills(params: SkillListParams = {}): Promise<SkillListResponse> {
  const search = new URLSearchParams();
  const category = normaliseCategory(params.category);
  if (category) search.set("category", category);
  if (params.sortBy) search.set("sort_by", params.sortBy);
  // `page`/`page_size` vão sempre dentro do contrato (1–100, default 20), nunca crus.
  search.set("page", String(clampPage(params.page)));
  search.set("page_size", String(clampPageSize(params.pageSize)));
  const suffix = search.toString() ? `?${search.toString()}` : "";
  return requestJson<SkillListResponse>(`/skills${suffix}`);
}

export function getSkill(skillId: string): Promise<SkillDetailResponse> {
  return requestJson<SkillDetailResponse>(`/skills/${encodeURIComponent(skillId)}`);
}
