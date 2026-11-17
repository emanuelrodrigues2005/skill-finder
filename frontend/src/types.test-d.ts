/**
 * Type-level locks for the API contract (issue #24).
 *
 * Compiled by `tsc --noEmit` (`tsconfig.json` → `include: ["src"]`), never imported by
 * the application, so nothing here reaches the bundle. Each `Expect<…>` is a compile
 * error when the declaration drifts from `openapi.yaml`; the alias name says which
 * field broke, because `tsc` reports the alias, not the sentence around it.
 *
 * Source of truth: `openapi.yaml` (frozen, 10 endpoints / 5 public).
 */

import type { Llm, LlmStatus, ResultItem, ScoreBreakdown, SecurityStatus, SkillSummary } from "./types";
import type { ApiError } from "./api";

/** `true` only when `X` and `Y` are the same type (not merely assignable). */
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

/** Compiles only when its argument is `true`. */
type Expect<T extends true> = T;

/** openapi.yaml › components.schemas.LlmInfo.status — exactly these 7, both directions. */
export type LlmStatusMatchesContract = Expect<
  Equal<LlmStatus, "ok" | "cached" | "repaired" | "invalid_ids" | "low_confidence" | "unavailable" | "disabled">
>;

/** `Llm.status` must actually be the union, not a widened `string`. */
export type LlmStatusIsUsedByLlm = Expect<Equal<Llm["status"], LlmStatus>>;

/** openapi.yaml › components.schemas.SkillSummary.properties.security_status.enum — exactly 4. */
export type SecurityStatusMatchesContract = Expect<Equal<SecurityStatus, "ok" | "warn" | "fail" | "unknown">>;

/** openapi.yaml › components.schemas.SkillSummary.properties.security_status — used, not widened. */
export type SecurityStatusIsUsedBySummary = Expect<Equal<SkillSummary["security_status"], SecurityStatus>>;

/** openapi.yaml › components.schemas.ScoreBreakdown — the three factors are `number`, never `null`. */
export type ScoreBreakdownStarsHasNoNull = Expect<Equal<ScoreBreakdown["stars"], number>>;
export type ScoreBreakdownVulnerabilitiesHasNoNull = Expect<
  Equal<ScoreBreakdown["vulnerabilities"], number>
>;
export type ScoreBreakdownInstallsHasNoNull = Expect<Equal<ScoreBreakdown["installs"], number>>;

/** openapi.yaml › components.schemas.ResultItem — `caveats` is required and `string | null`. */
export type ResultItemCaveatsIsNullableString = Expect<Equal<ResultItem["caveats"], string | null>>;

/** openapi.yaml › components.schemas.SkillSummary — nullable fields carry `null`, not `undefined`. */
export type SkillSummarySourceUrlIsNullable = Expect<Equal<SkillSummary["source_url"], string | null>>;
export type SkillSummaryCategoryIsNullable = Expect<Equal<SkillSummary["category"], string | null>>;

/** openapi.yaml › components.schemas.LlmInfo.model — null without a provider call. */
export type LlmModelIsNullable = Expect<Equal<Llm["model"], string | null>>;

/**
 * openapi.yaml › components.schemas.ErrorBody.properties.retry_after_seconds — `integer | null`
 * (only meaningful on 429). `ApiError` normalises the optional envelope field to `number | null`,
 * like it already does for `requestId`.
 */
export type ApiErrorRetryAfterSecondsIsNullable = Expect<Equal<ApiError["retryAfterSeconds"], number | null>>;
