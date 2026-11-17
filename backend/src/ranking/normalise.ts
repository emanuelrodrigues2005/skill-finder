/**
 * Raw catalog numbers to normalised factors (`01-spec-produto.md` §5.3, §5.5).
 *
 * Pure arithmetic only: fixed anchors, no min-max over the retrieved set, so a
 * score stays comparable between searches and cacheable.
 */

/** The neutral factor an absent field receives; it never becomes 0 or a 1. */
export const NEUTRAL_FACTOR = 0.5;

/** Anchors that make a factor reach 1.0 (§5.3). */
export const STARS_ANCHOR = 20_000;
export const INSTALLS_ANCHOR = 200_000;
export const VULNERABILITY_SATURATION = 5;

/**
 * Penalty per absent field, indexed by `missing_fields` (§5.5).
 *
 * Literal table on purpose: `1 - 0.1 * m` yields `0.6999999999999999` for
 * `m = 3`, which a strict JSON/`toEqual` consumer would see as a different
 * number. With the table the exposed value is exactly `0.7`.
 */
export const PENALTY_BY_MISSING_FIELDS: readonly number[] = [1, 0.9, 0.8, 0.7];

/** `{stars, installs, vulnerability_count}` — the three fields that can be absent. */
export const COUNTED_FIELDS = 3;

/**
 * A raw value is usable only when it is a non-negative finite number.
 *
 * Negative and non-finite values (including `NaN`) are treated as absent, not
 * as data: `log10` of a negative number is `NaN` and one poisoned row must not
 * be able to produce a `NaN` score.
 */
export function isUsable(raw: number | null | undefined): raw is number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0;
}

/** Clamps to [0,1]; `NaN` collapses to 0 so the score can never be `NaN`. */
export function clamp01(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

/**
 * Rounds to four decimal places, half-up.
 *
 * `Math.round(x * 1e4) / 1e4` is half-up on the binary value, not
 * decimal-half-up: a raw value that is mathematically exactly `….5` at the
 * fifth place can round down because its binary representation sits a hair
 * below. No case of §5.7 lands near such a boundary, so the difference is not
 * observable here; a documented limitation is cheaper than decimal arithmetic.
 */
export function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

/** `clamp01(log10(1 + raw) / log10(1 + anchor))` — the fixed-anchor log scale. */
export function logScale(raw: number, anchor: number): number {
  return clamp01(Math.log10(1 + raw) / Math.log10(1 + anchor));
}

/** `S` (§5.3): absent stars are neutral, never a zeroed or maximal factor. */
export function starsFactor(raw: number | null | undefined): number {
  return isUsable(raw) ? logScale(raw, STARS_ANCHOR) : NEUTRAL_FACTOR;
}

/** `P` (§5.3): `1 - vulns/5`, saturating at 5 reported vulnerabilities. */
export function vulnerabilitiesFactor(raw: number | null | undefined): number {
  return isUsable(raw) ? clamp01(1 - raw / VULNERABILITY_SATURATION) : NEUTRAL_FACTOR;
}

/** `I` (§5.3): same log scale as stars, with the installs anchor. */
export function installsFactor(raw: number | null | undefined): number {
  return isUsable(raw) ? logScale(raw, INSTALLS_ANCHOR) : NEUTRAL_FACTOR;
}

/** The penalty multiplier for `m` absent fields; capped at `m = 3` (§5.5). */
export function penaltyFor(missingFields: number): number {
  const index = Math.min(Math.max(missingFields, 0), PENALTY_BY_MISSING_FIELDS.length - 1);
  return PENALTY_BY_MISSING_FIELDS[index];
}
