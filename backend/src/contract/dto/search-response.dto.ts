import { ApiExtraModels, ApiProperty } from '@nestjs/swagger';

import { ExplainPayload } from './explain.dto';
import { ResultItem } from './result-item.dto';

/** Os sete estados de `llm.status` (§5.3), nesta ordem — renomear é mudança de contrato. */
export const LLM_STATUSES = [
  'ok',
  'cached',
  'repaired',
  'invalid_ids',
  'low_confidence',
  'unavailable',
  'disabled',
] as const;

export type LlmStatus = (typeof LLM_STATUSES)[number];

/** `degraded_reason` é bi-valorado e `null` quando nada degrada (§5.3). */
export const DEGRADED_REASONS = ['source_stale', 'llm_unavailable'] as const;

export type DegradedReason = (typeof DEGRADED_REASONS)[number];

/** Pode haver outros filtros no futuro; hoje só este é contratado. */
export class IntentFilters {
  @ApiProperty({ type: Boolean, description: 'Drop skills with a reported vulnerability.' })
  exclude_with_vulnerabilities!: boolean;
}

/** Intenção interpretada pela LLM e validada contra o enum de categorias (§6.1). */
export class Intent {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Category slug, when the request names one.',
  })
  category!: string | null;

  @ApiProperty({
    type: [String],
    description: 'Keywords extracted from the natural-language query.',
  })
  keywords!: string[];

  @ApiProperty({ type: () => IntentFilters })
  filters!: IntentFilters;

  @ApiProperty({ type: String, description: 'Language the query was written in.' })
  language!: string;

  @ApiProperty({
    type: Number,
    minimum: 0,
    maximum: 1,
    description: 'Confidence of the extraction.',
  })
  confidence!: number;
}

export class TokenUsage {
  @ApiProperty({ type: 'integer', minimum: 0, description: 'Prompt tokens billed for the call.' })
  prompt!: number;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: 'Completion tokens billed for the call.',
  })
  completion!: number;
}

/**
 * O que a LLM fez nesta busca; `cached` diz se houve chamada ao provedor.
 *
 * O schema interno do `explain` (`ExplainPayload`) não tem path público — o
 * serviço o valida, não o serve — mas o contrato versionado precisa registrá-lo.
 * `@ApiExtraModels` num modelo que o documento já explora o põe em
 * `components.schemas` sem criar operação, o mesmo mecanismo que
 * `ApiErrorResponses` usa para o `ErrorEnvelope`.
 */
@ApiExtraModels(ExplainPayload)
export class LlmInfo {
  @ApiProperty({
    enum: [...LLM_STATUSES],
    description: 'How the LLM step ended. `disabled` is the LLM_ENABLED=false mode.',
  })
  status!: LlmStatus;

  @ApiProperty({
    enum: [...LLM_STATUSES],
    nullable: true,
    description:
      'How the explain step ended; null when it was not attempted (e.g. a replayed search).',
  })
  // Opcional no tipo só enquanto o passo de explicação não popula a resposta
  // (issue #42, `src/search/**`): o contrato OpenAPI o mantém **obrigatório** —
  // sempre presente, com `null` quando o passo não foi tentado. Quem constrói
  // `LlmInfo` tem que preencher; `null` e ausente não são a mesma coisa.
  explain_status!: LlmStatus | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Model that produced the intent; on a cache hit it is the model that produced the cached answer. null only when no intent could be produced.',
  })
  model!: string | null;

  @ApiProperty({ type: Boolean, description: 'True when the answer came from the search cache.' })
  cached!: boolean;

  @ApiProperty({
    type: () => TokenUsage,
    nullable: true,
    description: 'null when no provider call happened.',
  })
  tokens!: TokenUsage | null;
}

/** Frescor do catálogo e degradação visível (§7 do CONTEXT.md). */
export class SearchData {
  @ApiProperty({ type: Boolean, description: 'True when the answer fell back to a degraded path.' })
  degraded!: boolean;

  @ApiProperty({
    enum: [...DEGRADED_REASONS],
    nullable: true,
    description: 'Why the answer is degraded; null when `degraded` is false.',
  })
  degraded_reason!: DegradedReason | null;

  @ApiProperty({
    type: String,
    example: 'cache',
    description:
      'Where the candidate set came from. §5.3 documents only `cache`; other values are not contracted yet.',
  })
  source!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'RFC 3339 UTC of the catalog snapshot.',
  })
  catalog_snapshot!: string;

  @ApiProperty({ type: 'integer', minimum: 0, description: 'Age of the snapshot in seconds.' })
  age_seconds!: number;
}

/** Recomendação única, em texto, com placeholders já resolvidos (§5.3). */
export class Recommendation {
  @ApiProperty({ type: String, description: 'skill_id the text argues for; must be in `results`.' })
  skill_id!: string;

  @ApiProperty({
    type: String,
    description: 'Plain text from an untrusted source. Render escaped; never as HTML or markdown.',
  })
  text!: string;
}

/**
 * Resposta de `POST /api/v1/search` e de `GET /api/v1/searches/{request_id}`
 * (§5.3). Na recuperação do histórico, `llm.cached` vem `true`.
 */
export class SearchResponse {
  @ApiProperty({ type: String, example: 'req_01JCV8Y6Q4' })
  request_id!: string;

  @ApiProperty({
    type: String,
    description: 'Stored search id; every stored search response carries one (§5.3).',
  })
  search_id!: string;

  @ApiProperty({ type: () => Intent })
  intent!: Intent;

  @ApiProperty({ type: () => LlmInfo })
  llm!: LlmInfo;

  @ApiProperty({ type: () => SearchData })
  data!: SearchData;

  @ApiProperty({ type: [ResultItem], description: 'Ranked results; at most `limit` (≤ 20).' })
  results!: ResultItem[];

  @ApiProperty({
    type: () => Recommendation,
    nullable: true,
    description: 'null when there is nothing worth recommending.',
  })
  recommendation!: Recommendation | null;

  @ApiProperty({
    type: 'array',
    items: {
      type: 'string',
      description:
        'Plain text from an untrusted source. Render escaped; never as HTML or markdown.',
    },
    description: 'Non-fatal problems the user should see (e.g. degraded source).',
  })
  warnings!: string[];
}
