/**
 * Formatação da transcrição: `null` → `n/a`, casas decimais e a idade do catálogo.
 *
 * Regra 3 do `AGENTS.md`: dado ausente é `null`, jamais `0` — a tela mostra `n/a`. A conversão
 * mora aqui porque os turnos que mostram número precisam todos da mesma resposta, e a cópia
 * anterior espalhada por `ResultsPage.tsx` era o caminho para uma delas divergir.
 */
import { STR } from "../../ui/strings";

/** `null`/`undefined` do contrato viram `n/a`; `0` que o servidor mandou é dado real e aparece. */
export function show(value: string | number | null | undefined): string {
  return value === null || value === undefined ? STR.common.na : String(value);
}

/** Casas decimais só na apresentação: o número exibido é o que a API mandou. */
export function decimals(value: number, digits: number): string {
  return value.toFixed(digits);
}

/**
 * `age_seconds` → horas, para a nota de catálogo desatualizado (US-08 AC2). É divisão e
 * formatação: nenhum arredondamento feito à mão.
 */
export function ageInHours(ageSeconds: number): string {
  return decimals(ageSeconds / 3600, 1);
}
