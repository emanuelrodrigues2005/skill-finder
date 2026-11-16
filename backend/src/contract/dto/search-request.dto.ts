import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Corpo de `POST /api/v1/search` (§5.2). As regras de `class-validator` que
 * aplicam estes limites em runtime chegam com o handler da F2.6; aqui o DTO é a
 * fonte do schema do `openapi.yaml`, e os limites são os mesmos dos dois lados.
 */
export class SearchRequest {
  @ApiProperty({
    type: String,
    minLength: 3,
    maxLength: 500,
    example: 'I need a skill that reviews pull requests for security problems in Python services',
    description:
      'Natural-language description of the skill the user needs, after strip and NFKC normalisation (3–500 characters, no control characters).',
  })
  query!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    minLength: 1,
    description:
      'Existing category slug, validated against the `category` table. null or omitted means every category (the frontend client sends `null` when the user picks none).',
  })
  category?: string | null;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: 20,
    default: 5,
    description: 'How many ranked results to return (1–20). Hard ceiling: 20.',
  })
  limit?: number;
}
