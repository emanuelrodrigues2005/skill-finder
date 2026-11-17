/**
 * From one catalog row to a rounded score (`01-spec-produto.md` §5.4, §5.5).
 *
 * `score = round4( (wS·S + wP·P + wI·I) × penalty[m] )`, with `m` the number of
 * absent fields among `{stars, installs, vulnerability_count}`. An absent field
 * pays twice: it gets the neutral `0.5` *and* it counts in `m` (§5.5).
 */

import {
  COUNTED_FIELDS,
  clamp01,
  installsFactor,
  isUsable,
  penaltyFor,
  round4,
  starsFactor,
  vulnerabilitiesFactor,
} from './normalise';
import type { RankingCandidate, RankingWeights, ScoreBreakdown } from './types';

/** A candidate with its factors and final score — the internal sort row. */
export interface ScoredCandidate {
  readonly candidate: RankingCandidate;
  readonly factors: ScoreBreakdown;
  readonly score: number;
}

/** Normalised factors plus the missing-data bookkeeping for one candidate. */
export function normaliseCandidate(candidate: RankingCandidate): ScoreBreakdown {
  const missingFields = countMissingFields(candidate);

  return {
    stars: starsFactor(candidate.stars),
    vulnerabilities: vulnerabilitiesFactor(candidate.vulnerability_count),
    installs: installsFactor(candidate.installs),
    missing_fields: missingFields,
    penalty_factor: penaltyFor(missingFields),
  };
}

/** `m` of §5.4: how many of the three counted fields are absent. */
export function countMissingFields(candidate: RankingCandidate): number {
  let missing = 0;
  if (!isUsable(candidate.stars)) {
    missing += 1;
  }
  if (!isUsable(candidate.vulnerability_count)) {
    missing += 1;
  }
  if (!isUsable(candidate.installs)) {
    missing += 1;
  }
  return Math.min(missing, COUNTED_FIELDS);
}

/** The weighted sum of the factors, before the missing-data penalty. */
export function weightedSum(factors: ScoreBreakdown, weights: RankingWeights): number {
  return (
    weights.stars * factors.stars +
    weights.vulnerabilities * factors.vulnerabilities +
    weights.installs * factors.installs
  );
}

/** Final score, rounded to four places and guaranteed inside [0,1]. */
export function computeScore(factors: ScoreBreakdown, weights: RankingWeights): number {
  return round4(clamp01(weightedSum(factors, weights) * factors.penalty_factor));
}

/** Scores one candidate against already-resolved weights. */
export function scoreCandidate(
  candidate: RankingCandidate,
  weights: RankingWeights,
): ScoredCandidate {
  const factors = normaliseCandidate(candidate);
  return { candidate, factors, score: computeScore(factors, weights) };
}
