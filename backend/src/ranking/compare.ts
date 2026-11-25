/**
 * The total order of §5.6 — six criteria, the last one always decisive.
 *
 * 1. `score` descending, compared on the **rounded** value so the number shown
 *    is the number used to sort.
 * 2. `relevance` descending — how well the row matches the query text, the
 *    `ts_rank` the catalog already computes (absent counts as `0`, the neutral
 *    of "no textual evidence").
 * 3. `vulnerability_count` ascending on the treated value (`?? 2.5`, the neutral
 *    of `P = 0.5`).
 * 4. `installs` descending (absent counts as `0` **here only**).
 * 5. `stars` descending (same treatment).
 * 6. `skill_id` ascending by UTF-16 code unit.
 */

import { isUsable } from './normalise';
import type { ScoredCandidate } from './score';

/** Neutral vulnerability count used by tie-break 3 (`P = 0.5` ⇔ `2.5/5`). */
export const VULNERABILITY_TIE_NEUTRAL = 2.5;

/**
 * Neutral relevance used by tie-break 2: a candidate the catalog gave no
 * `ts_rank` for (the in-memory double) carries no textual evidence at all, and
 * `0` is what "matched no term" means in `ts_rank` — never a perfect match.
 */
export const RELEVANCE_TIE_NEUTRAL = 0;

/** Raw count for tie-break 3: absent values behave as `2.5`. */
export function tieVulnerability(value: number | null | undefined): number {
  return isUsable(value) ? value : VULNERABILITY_TIE_NEUTRAL;
}

/** Raw relevance for tie-break 2: absent values behave as `0`. */
export function tieRelevance(value: number | null | undefined): number {
  return isUsable(value) ? value : RELEVANCE_TIE_NEUTRAL;
}

/** Raw count for tie-breaks 4 and 5: absent values behave as `0`. */
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

  // Before popularity on purpose: among equal scores, the row that matches the
  // query text better is the answer. Popularity only decides when the text
  // match ties too — otherwise a 4.5M-install skill that merely shares a word
  // with the query outranks the skill the user described.
  const byRelevance = compareDescending(
    tieRelevance(a.candidate.relevance),
    tieRelevance(b.candidate.relevance),
  );
  if (byRelevance !== 0) {
    return byRelevance;
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
