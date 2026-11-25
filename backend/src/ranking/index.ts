/**
 * Ranking — deterministic scoring and total ordering (`01-spec-produto.md` §5).
 *
 * Import from `src/ranking`; the submodules are implementation details.
 */

export {
  compareScored,
  compareSkillIds,
  RELEVANCE_TIE_NEUTRAL,
  tieCount,
  tieRelevance,
  tieVulnerability,
} from './compare';
export {
  COUNTED_FIELDS,
  INSTALLS_ANCHOR,
  NEUTRAL_FACTOR,
  PENALTY_BY_MISSING_FIELDS,
  STARS_ANCHOR,
  VULNERABILITY_SATURATION,
  clamp01,
  installsFactor,
  isUsable,
  logScale,
  penaltyFor,
  round4,
  starsFactor,
  vulnerabilitiesFactor,
} from './normalise';
export { rank } from './rank';
export {
  computeScore,
  countMissingFields,
  normaliseCandidate,
  scoreCandidate,
  weightedSum,
  type ScoredCandidate,
} from './score';
export type {
  EvidenceCompleteness,
  RankedItem,
  RankingCandidate,
  RankingIntent,
  RankingWeights,
  ScoreBreakdown,
} from './types';
export { DEFAULT_WEIGHTS, WEIGHT_SUM_TOLERANCE, resolveWeights } from './weights';
