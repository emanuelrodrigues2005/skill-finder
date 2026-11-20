import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Corpo `200` de `/healthz` e `/readyz` (formato do `@nestjs/terminus`).
 *
 * O envelope de §5.5 vale para status ≥400; o probe saudável responde este
 * objeto com `status: "ok"` e o detalhe de cada indicador.
 */
export class HealthResponse {
  @ApiProperty({ type: String, example: 'ok', description: '`ok` when every indicator passed.' })
  status!: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description: 'Indicators that passed.',
  })
  info?: Record<string, unknown>;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description: 'Indicators that failed.',
  })
  error?: Record<string, unknown>;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description: 'Detail per indicator.',
  })
  details?: Record<string, unknown>;
}
