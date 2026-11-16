import { ApiProperty } from '@nestjs/swagger';

import { SkillSummary } from './catalog.dto';

/**
 * Fatores de score normalizados em [0,1] (S/P/I de §6.4 e `01-spec-produto.md`).
 *
 * São `number` e **nunca** `null`: o fator é calculado para todo resultado
 * ranqueado — dado ausente entra no `missing_fields`/`penalty_factor`, não no
 * fator. Por isso `stars`/`installs` aqui não compartilham a nulabilidade dos
 * mesmos nomes em `SkillSummary`.
 */
export class ScoreBreakdown {
  @ApiProperty({ type: Number, minimum: 0, maximum: 1, description: 'Normalised stars factor.' })
  stars!: number;

  @ApiProperty({
    type: Number,
    minimum: 0,
    maximum: 1,
    description: 'Normalised vulnerability factor (1 = no reported vulnerability).',
  })
  vulnerabilities!: number;

  @ApiProperty({
    type: Number,
    minimum: 0,
    maximum: 1,
    description: 'Normalised installs factor.',
  })
  installs!: number;

  @ApiProperty({ type: 'integer', minimum: 0, description: 'How many inputs were missing.' })
  missing_fields!: number;

  @ApiProperty({
    type: Number,
    minimum: 0,
    maximum: 1,
    description: 'Multiplier applied for the gaps.',
  })
  penalty_factor!: number;
}

/** Quanto da evidência da skill existe; alimenta o `n/a` da interface (§5.3). */
export class EvidenceCompleteness {
  @ApiProperty({ type: 'integer', minimum: 0, description: 'Fields absent from the catalog row.' })
  missing_fields!: number;

  @ApiProperty({
    type: Number,
    minimum: 0,
    maximum: 1,
    description: 'Confidence multiplier for the gaps.',
  })
  penalty_factor!: number;
}

/**
 * Item ranqueado de `POST /api/v1/search` (§5.3).
 *
 * `score` e `score_breakdown` são do servidor; `explanation` é texto da LLM com
 * placeholders `{{skill:<skill_id>}}`, já substituídos pelo nome do banco.
 */
export class ResultItem {
  @ApiProperty({ type: 'integer', minimum: 1, description: '1-based position in the ranked list.' })
  rank!: number;

  @ApiProperty({ type: Number, minimum: 0, maximum: 1, description: 'Final score; ordering key.' })
  score!: number;

  @ApiProperty({ type: () => ScoreBreakdown })
  score_breakdown!: ScoreBreakdown;

  @ApiProperty({ type: () => EvidenceCompleteness })
  evidence_completeness!: EvidenceCompleteness;

  @ApiProperty({
    type: () => SkillSummary,
    description: 'Always rebuilt from the database; never taken from the LLM output.',
  })
  skill!: SkillSummary;

  @ApiProperty({
    type: String,
    maxLength: 1200,
    description: 'Plain text from an untrusted source. Render escaped; never as HTML or markdown.',
  })
  explanation!: string;

  @ApiProperty({
    type: [String],
    description: 'Validation flags for this item (e.g. `explanation_repaired`); empty when clean.',
  })
  flags!: string[];

  @ApiProperty({
    type: String,
    nullable: true,
    maxLength: 160,
    description:
      'Free-text caveat about missing evidence; null when there is nothing to call out. Plain text from an untrusted source. Render escaped; never as HTML or markdown.',
  })
  caveats!: string | null;
}
