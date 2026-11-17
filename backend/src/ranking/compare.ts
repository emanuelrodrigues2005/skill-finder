/**
 * The total order of §5.6 — five criteria, the last one always decisive.
 *
 * 1. `score` descending, compared on the **rounded** value so the number shown
 *    is the number used to sort.
 * 2. `vulnerability_count` ascending on the treated value (`?? 2.5`, the neutral
 *    of `P = 0.5`).
 * 3. `installs` descending (absent counts as `0` **here only**).
 * 4. `stars` descending (same treatment).
 * 5. `skill_id` ascending by UTF-16 code unit.
 */

import { isUsable } from './normalise';
import type { ScoredCandidate } from './score';

/** Neutral vulnerability count used by tie-break 2 (`P = 0.5` ⇔ `2.5/5`). */
export const VULNERABILITY_TIE_NEUTRAL = 2.5;

/** Raw count for tie-break 2: absent values behave as `2.5`. */
export function tieVulnerability(value: number | null | undefined): number {
  return isUsable(value) ? value : VULNERABILITY_TIE_NEUTRAL;
}

/** Raw count for tie-breaks 3 and 4: absent values behave as `0`. */
export function tieCount(value: number | null | undefined): number {
  return isUsable(value) ? value : 0;
}

/**
 * Ordinal comparison by UTF-16 code unit.
 *
 * `localeCompare` is deliberately avoided: it is locale-dependent and orders
 * `'a'` before `'B'`, which would make the ranking depend on the host (§5.6).
 */
export function compareSkillIds(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

/** Descending numeric comparison that never returns `0` for distinct numbers. */
function compareDescending(a: number, b: number): number {
  if (a === b) {
    return 0;
  }
  return a < b ? 1 : -1;
}

/** Ascending numeric comparison that never returns `0` for distinct numbers. */
function compareAscending(a: number, b: number): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/**
 * Full comparator: negative when `a` ranks first, positive when `b` does, `0`
 * only for the same `skill_id` (a duplicate row).
 */
export function compareScored(a: ScoredCandidate, b: ScoredCandidate): number {
  const byScore = compareDescending(a.score, b.score);
  if (byScore !== 0) {
    return byScore;
  }

  const byVulnerabilities = compareAscending(
    tieVulnerability(a.candidate.vulnerability_count),
    tieVulnerability(b.candidate.vulnerability_count),
  );
  if (byVulnerabilities !== 0) {
    return byVulnerabilities;
  }

  const byInstalls = compareDescending(
    tieCount(a.candidate.installs),
    tieCount(b.candidate.installs),
  );
  if (byInstalls !== 0) {
    return byInstalls;
  }

  const byStars = compareDescending(tieCount(a.candidate.stars), tieCount(b.candidate.stars));
  if (byStars !== 0) {
    return byStars;
  }

  return compareSkillIds(a.candidate.skill_id, b.candidate.skill_id);
}
