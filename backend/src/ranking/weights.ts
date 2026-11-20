/**
 * Weight handling for the score (`01-spec-produto.md` §5.4).
 *
 * Weights are configuration (`RANK_W_STARS`, `RANK_W_VULNS`, `RANK_W_INSTALLS`),
 * so they enter by parameter — this module never reads the environment. A bad
 * configuration fails loudly here instead of silently reordering every search.
 */

import type { RankingWeights } from './types';

/** Ratified defaults of §5.4: stars 50%, vulnerabilities 30%, installs 20%. */
export const DEFAULT_WEIGHTS: RankingWeights = Object.freeze({
  stars: 0.5,
  vulnerabilities: 0.3,
  installs: 0.2,
});

/**
 * Sum tolerance. The three ratified weights do not add up to `1` exactly in
 * IEEE-754 (`0.5 + 0.3 + 0.2` drifts in the last bit), and neither do valid
 * decimal triples such as `0.6 + 0.25 + 0.15`; `=== 1` would reject both.
 */
export const WEIGHT_SUM_TOLERANCE = 1e-9;

function isWeight(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Validates and normalises the weights.
 *
 * Rejects: a non-finite weight, a negative weight, a non-positive sum, and any
 * sum that is not `1` within {@link WEIGHT_SUM_TOLERANCE}. The message names the
 * environment variables that carry the values plus the sum actually received.
 */
export function resolveWeights(raw?: RankingWeights | null): RankingWeights {
  if (raw === undefined || raw === null) {
    return DEFAULT_WEIGHTS;
  }

  const { stars, vulnerabilities, installs } = raw;
  const sum = stars + vulnerabilities + installs;
  const invalid =
    !isWeight(stars) ||
    !isWeight(vulnerabilities) ||
    !isWeight(installs) ||
    !Number.isFinite(sum) ||
    sum <= 0 ||
    Math.abs(sum - 1) > WEIGHT_SUM_TOLERANCE;

  if (invalid) {
    throw new RangeError(
      'Invalid ranking weights: ' +
        `RANK_W_STARS=${String(stars)}, RANK_W_VULNS=${String(vulnerabilities)}, ` +
        `RANK_W_INSTALLS=${String(installs)} — each weight must be finite and >= 0, ` +
        `and the three must sum to 1 (received sum ${String(sum)}, tolerance ${WEIGHT_SUM_TOLERANCE}).`,
    );
  }

  return { stars, vulnerabilities, installs };
}
