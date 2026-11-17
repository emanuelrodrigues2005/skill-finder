/**
 * `rank` — the single entry point of the deterministic ranking
 * (`01-spec-produto.md` §5.2–§5.9, `AGENTS.md` rule 1).
 *
 * Pure: same input, same output, always. No I/O, no clock, no randomness, no
 * environment. The LLM never orders anything; it only explains this order.
 */

import { compareScored } from './compare';
import { isUsable } from './normalise';
import { scoreCandidate, type ScoredCandidate } from './score';
import type { RankedItem, RankingCandidate, RankingIntent, RankingWeights } from './types';
import { resolveWeights } from './weights';

/**
 * Drops candidates that report at least one vulnerability, when the intent
 * asks for it (§5.2.2 filter). A candidate whose count is absent is *unknown*,
 * not clean, so it stays — the missing-data penalty is the visible caveat.
 */
function filterByIntent(
  candidates: readonly RankingCandidate[],
  intent: RankingIntent | undefined,
): readonly RankingCandidate[] {
  if (intent?.excludeWithVulnerabilities !== true) {
    return candidates;
  }
  return candidates.filter(
    (candidate) => !(isUsable(candidate.vulnerability_count) && candidate.vulnerability_count > 0),
  );
}

/**
 * Ranks the candidates, best first, with a contiguous 1-based `rank`.
 *
 * Weights come only from the third parameter; anything named `weights` inside
 * `intent` is ignored (§5.4 — weights are configuration, not intent).
 * The input array and its objects are never mutated.
 */
export function rank(
  candidates: readonly RankingCandidate[],
  intent?: RankingIntent,
  weights?: RankingWeights,
): RankedItem[] {
  const resolvedWeights = resolveWeights(weights);

  const scored: ScoredCandidate[] = filterByIntent(candidates, intent).map((candidate) =>
    scoreCandidate(candidate, resolvedWeights),
  );
  scored.sort(compareScored);

  return scored.map((row, index) => ({
    skill_id: row.candidate.skill_id,
    rank: index + 1,
    score: row.score,
    score_breakdown: {
      stars: row.factors.stars,
      vulnerabilities: row.factors.vulnerabilities,
      installs: row.factors.installs,
      missing_fields: row.factors.missing_fields,
      penalty_factor: row.factors.penalty_factor,
    },
    evidence_completeness: {
      missing_fields: row.factors.missing_fields,
      penalty_factor: row.factors.penalty_factor,
    },
  }));
}
