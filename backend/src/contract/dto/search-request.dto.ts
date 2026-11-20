import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

/**
 * Corpo de `POST /api/v1/search` (§5.2).
 *
 * O DTO é a fonte do schema do `openapi.yaml` **e** a regra que o
 * `ValidationPipe` aplica em runtime. Os limites são os mesmos dos dois lados:
 * `@ApiProperty({minLength})` descreve, o decorator de `class-validator` julga —
 * nenhum deles entra no documento gerado, então o contrato continua congelado
 * (decisão D-G).
 *
 * `query` passa por NFKC e `trim` antes da validação: o `minLength` mede o texto
 * que o usuário realmente digitou, não o padding em volta dele.
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
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.normalize('NFKC').trim() : value,
  )
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  query!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    minLength: 1,
    description:
      'Existing category slug, validated against the `category` table. null or omitted means every category (the frontend client sends `null` when the user picks none).',
  })
  // `null` é valor válido (o cliente manda `null` quando não escolhe nada), por
  // isso `@IsOptional()` e não `@ValidateIf`: ele descarta `null`/`undefined` e
  // deixa a string ser julgada pelo `@IsString`.
  @IsOptional()
  @IsString()
  @MinLength(1)
  // Teto do slug de ingestão (curto por construção). Sem ele, a categoria
  // desconhecida é ecoada sem limite em `error.message` pelo serviço, e o corpo
  // da resposta vira um vetor de amplificação. Não é `@ApiProperty`: o schema
  // congelado não muda (decisão D-G).
  @MaxLength(64)
  category?: string | null;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: 20,
    default: 5,
    description: 'How many ranked results to return (1–20). Hard ceiling: 20.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  limit?: number;
}
