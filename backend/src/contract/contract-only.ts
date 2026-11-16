/**
 * Mensagem única dos handlers que existem só para congelar o contrato v0.
 *
 * Nenhum destes endpoints tem serviço por trás ainda: devolver dado inventado
 * seria pior do que falhar. O 500 `INTERNAL` já está declarado na tabela de
 * status de cada operação (§5.5), então a falha observável segue o contrato.
 */
export const CONTRACT_ONLY_MESSAGE = 'contract-only endpoint: runtime owner is F2.3';

export function contractOnly(): never {
  throw new Error(CONTRACT_ONLY_MESSAGE);
}
