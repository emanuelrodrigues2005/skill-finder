/**
 * Public types for the deterministic ranking (`01-spec-produto.md` §5.3–§5.9).
 *
 * The module is a pure function: no I/O, no clock, no randomness (`AGENTS.md`
 * rule 1). Every input arrives by parameter, including the weights.
 */

/**
 * The three catalog numbers the ranking consumes for one skill.
 *
 * `null` means *absent*, never zero: an absent field gets the neutral factor
 * and increments `missing_fields` (§5.5). `undefined` is accepted as a synonym
 * of `null` because an omitted property deserialises that way.
 */
export interface RankingCandidate {
  readonly skill_id: string;
  readonly stars?: number | null;
  readonly installs?: number | null;
  readonly vulnerability_count?: number | null;
}

/**
 * Weights of the linear combination (§5.4). Configuration, not code: they come
 * from `RANK_W_STARS` / `RANK_W_VULNS` / `RANK_W_INSTALLS` through the caller.
 */
export interface RankingWeights {
  readonly stars: number;
  readonly vulnerabilities: number;
  readonly installs: number;
}

/**
 * The slice of the interpreted intent that changes the ranked set.
 *
 * Weights are deliberately *not* here: they enter through the dedicated
 * parameter, so a `weights` key smuggled into the intent cannot change order.
 */
export interface RankingIntent {
  readonly excludeWithVulnerabilities?: boolean;
}

/** Normalised factors in [0,1] plus the missing-data bookkeeping (§5.4, §5.5). */
export interface ScoreBreakdown {
  readonly stars: number;
  readonly vulnerabilities: number;
  readonly installs: number;
  readonly missing_fields: number;
  readonly penalty_factor: number;
}

/** How much evidence the catalog row carries; drives the `n/a` in the UI. */
export interface EvidenceCompleteness {
  readonly missing_fields: number;
  readonly penalty_factor: number;
}

/**
 * One ranked row. Mirrors the score-bearing fields of the API `ResultItem`
 * (`contract/dto/result-item.dto.ts`); the DTO adds the catalog summary and the
 * LLM explanation, which this module never produces.
 */
export interface RankedItem {
  readonly skill_id: string;
  readonly rank: number;
  readonly score: number;
  readonly score_breakdown: ScoreBreakdown;
  readonly evidence_completeness: EvidenceCompleteness;
}
