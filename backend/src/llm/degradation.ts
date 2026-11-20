/**
 * Tabela `llm.status` -> `degraded` (`docs/app/02-arquitetura.md` §7.4).
 *
 * Regra 7 do `AGENTS.md`: a degradação é visível. `ok`, `cached` e `repaired`
 * entregaram o que prometem; os quatro restantes não — a busca segue, mas a
 * interface precisa dizer que a intenção veio de um caminho degradado.
 *
 * Precedência: catálogo velho (`source_stale`) vence `llm_unavailable`, porque
 * um catálogo desatualizado contamina até a resposta boa da LLM.
 */
import type { DegradedReason, LlmStatus } from '@/contract/dto/search-response.dto';

/**
 * `Record<LlmStatus, boolean>` de propósito: acrescentar um status ao contrato
 * sem decidir se ele degrada passa a ser erro de compilação, não bug silencioso.
 */
export const DEGRADED_BY_STATUS: Record<LlmStatus, boolean> = {
  ok: false,
  cached: false,
  repaired: false,
  invalid_ids: true,
  low_confidence: true,
  unavailable: true,
  disabled: true,
};

/** Resultado pronto para o envelope de resposta (§5.3). */
export interface Degradation {
  readonly degraded: boolean;
  readonly degraded_reason: DegradedReason | null;
}

/**
 * Compõe a degradação do status da LLM com o frescor do catálogo.
 *
 * @param status como o passo de intenção terminou.
 * @param catalogStale `true` quando o snapshot do catálogo passou do limite.
 */
export function resolveDegradation(status: LlmStatus, catalogStale = false): Degradation {
  if (catalogStale) {
    return { degraded: true, degraded_reason: 'source_stale' };
  }
  return DEGRADED_BY_STATUS[status]
    ? { degraded: true, degraded_reason: 'llm_unavailable' }
    : { degraded: false, degraded_reason: null };
}
