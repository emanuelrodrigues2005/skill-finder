import { ApiProperty } from '@nestjs/swagger';

/**
 * Payload do passo de explicação (§6.5) — **schema interno**, não é endpoint.
 *
 * É o formato que a LLM devolve e que o serviço valida antes de virar
 * `results[].explanation` e `recommendation`: nada disso sai do modelo e cai
 * direto na resposta pública (§5.3). Não tem path; entra no `openapi.yaml` por
 * `@ApiExtraModels` em `LlmInfo` (ver `search-response.dto.ts`) apenas para o
 * contrato versionado registrar os tetos de texto.
 */

/** Uma skill explicada: `skill_id` fechado no conjunto recuperado e texto curto. */
export class ExplainItem {
  @ApiProperty({
    type: String,
    description:
      'One of the ranked candidate ids; an id outside that set discards the item (§6.5).',
  })
  skill_id!: string;

  @ApiProperty({
    type: String,
    maxLength: 320,
    description:
      'Why this skill fits the query. Plain text from an untrusted source; render escaped.',
  })
  why!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    maxLength: 160,
    description:
      'What is missing or risky about this skill; null when there is nothing to call out.',
  })
  caveats!: string | null;
}

/** Destaque único; aponta para o `rank 1`, nunca para outro item da lista (§6.5). */
export class ExplainRecommendation {
  @ApiProperty({
    type: String,
    description: 'Candidate the recommendation highlights; must be the `rank 1` id (§6.5).',
  })
  skill_id!: string;

  @ApiProperty({
    type: String,
    maxLength: 400,
    description:
      'Why the highlighted skill is the starting point. Plain text from an untrusted source; render escaped.',
  })
  why!: string;
}

/** Saída completa de `LLMProvider.explain` (§6.5): só ids já recuperados entram aqui. */
export class ExplainPayload {
  @ApiProperty({
    type: [ExplainItem],
    description: 'One entry per explained candidate; ids outside the retrieved set are discarded.',
  })
  items!: ExplainItem[];

  @ApiProperty({
    type: () => ExplainRecommendation,
    description: 'Single recommendation, or a repair is requested when it is missing or off-set.',
  })
  recommendation!: ExplainRecommendation;
}
