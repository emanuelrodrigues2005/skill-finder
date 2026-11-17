/**
 * Issue #9 (F2.5) — tabela `llm.status` -> `degraded`, ratificada pelo architect.
 *
 * Contrato exigido do codigo de producao (`backend/src/llm/degradation.ts`):
 *
 *   export const DEGRADED_BY_STATUS: Record<LlmStatus, boolean>;
 *   export function resolveDegradation(
 *     status: LlmStatus,
 *     catalogStale?: boolean,     // default false
 *   ): { degraded: boolean; degraded_reason: DegradedReason | null };
 *
 * Composicao: `degraded = catalogStale || DEGRADED_BY_STATUS[status]`, com precedencia
 * `source_stale` > `llm_unavailable` (docs/app/02-arquitetura.md §7.4, regra 7 do AGENTS.md).
 *
 * `LlmStatus` e importado do contrato — a tabela nao redefine o enum. O caso `ok -> false` fica
 * explicito porque o setup do Jest fixa `LLM_ENABLED=false`: sem ele, a suite nunca veria
 * `degraded: false`.
 */
import {
  LLM_STATUSES,
  type DegradedReason,
  type LlmStatus,
} from '@/contract/dto/search-response.dto';
import { DEGRADED_BY_STATUS, resolveDegradation } from '@/llm/degradation';

type TableRow = readonly [LlmStatus, boolean, DegradedReason | null];

const TABLE: readonly TableRow[] = [
  ['ok', false, null],
  ['cached', false, null],
  ['repaired', false, null],
  ['invalid_ids', true, 'llm_unavailable'],
  ['low_confidence', true, 'llm_unavailable'],
  ['unavailable', true, 'llm_unavailable'],
  ['disabled', true, 'llm_unavailable'],
];

describe('degradation table (docs/app/02-arquitetura.md 7.4)', () => {
  it('maps the seven statuses without inventing one', () => {
    expect(LLM_STATUSES).toHaveLength(7);
    expect(TABLE).toHaveLength(LLM_STATUSES.length);
    expect(TABLE.map(([status]) => status).sort()).toEqual([...LLM_STATUSES].sort());
    expect(Object.keys(DEGRADED_BY_STATUS).sort()).toEqual([...LLM_STATUSES].sort());
  });

  it.each(TABLE)('status %s -> degraded=%s', (status, degraded, reason) => {
    expect(DEGRADED_BY_STATUS[status]).toBe(degraded);
    expect(resolveDegradation(status, false)).toEqual({
      degraded,
      degraded_reason: reason,
    });
  });

  it.each(TABLE)('status %s is degraded by a stale catalog', (status) => {
    expect(resolveDegradation(status, true)).toEqual({
      degraded: true,
      degraded_reason: 'source_stale',
    });
  });

  it('leaves a healthy ok answer undegraded', () => {
    // O setup fixa LLM_ENABLED=false; sem este caso a suite nunca veria `degraded: false`.
    expect(resolveDegradation('ok', false)).toEqual({ degraded: false, degraded_reason: null });
    expect(DEGRADED_BY_STATUS.ok).toBe(false);
  });

  it('defaults to a fresh catalog', () => {
    expect(resolveDegradation('cached')).toEqual({ degraded: false, degraded_reason: null });
    expect(resolveDegradation('unavailable')).toEqual({
      degraded: true,
      degraded_reason: 'llm_unavailable',
    });
  });

  it('never reports a reason when nothing is degraded', () => {
    for (const [status] of TABLE) {
      const { degraded, degraded_reason } = resolveDegradation(status, false);
      if (!degraded) {
        expect(degraded_reason).toBeNull();
      }
    }
  });
});
