/**
 * Limites da busca que o contrato de `docs/app/02-arquitetura.md` §5 rege.
 *
 * Ficam num módulo só porque cada um deles é uma promessa pública (teto de
 * `limit`, tamanho da página, retenção do histórico, idade máxima do snapshot) e
 * um `5` solto no meio de um `if` não diz de qual promessa ele veio.
 */

/** Default de `limit` de `POST /api/v1/search` (§5.2); o teto de 20 vive no DTO. */
export const DEFAULT_SEARCH_LIMIT = 5;

/**
 * Quantos candidatos o recuperador entrega antes do ranking.
 *
 * Maior que o teto de `limit` de propósito: o filtro de intenção
 * (`exclude_with_vulnerabilities`) e o desempate acontecem **depois** da
 * recuperação, então cortar em `limit` na consulta devolveria menos itens do que
 * o usuário pediu.
 */
export const CANDIDATE_POOL_SIZE = 50;

/** Snapshot do catálogo mais velho que isto torna a resposta degradada (§7.4). */
export const SOURCE_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/** Retenção do histórico de busca (§4.2): depois disto o permalink expira em 410. */
export const SEARCH_HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Paginação de `GET /api/v1/skills` (§5.6). */
export const DEFAULT_PAGE = 1;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/** Ordenação de `GET /api/v1/skills`: campo do catálogo, nunca texto livre. */
export const SKILL_SORT_FIELDS = ['installs', 'stars', 'name'] as const;

export type SkillSortField = (typeof SKILL_SORT_FIELDS)[number];

export const DEFAULT_SKILL_SORT: SkillSortField = 'installs';

/**
 * Valores de `warnings` da resposta (§5.3). O frontend decide a mensagem pelo
 * valor, então renomear um deles é mudança de contrato.
 */
export const SEARCH_WARNINGS = {
  /** Nenhum candidato: a lista sai vazia **explicada**, nunca em branco. */
  noResults: 'no_results',
  /** A explicação veio do template determinístico (D-C), não da LLM. */
  explanationFromTemplate: 'explanation_from_template',
  /** Snapshot do catálogo além de {@link SOURCE_STALE_AFTER_MS}. */
  sourceStale: 'source_stale',
} as const;

/** `details.reason` do 503 de catálogo vazio (§5.5). */
export const SOURCE_UNAVAILABLE_REASON = {
  cacheEmpty: 'cache_empty',
} as const;

/** `details.reason` do 422 de categoria inexistente (decisão D-A). */
export const VALIDATION_REASON = {
  unknownCategory: 'UNKNOWN_CATEGORY',
} as const;
