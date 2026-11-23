/**
 * Porta de persistência do orçamento **global** diário de chamadas da LLM
 * (issue #35).
 *
 * A reserva é o único ponto em que duas buscas concorrentes disputam a mesma
 * cota: por isso ela é uma instrução atômica no banco (`INSERT ... ON CONFLICT
 * DO UPDATE ... WHERE calls < teto`) e devolve a decisão pronta. Um contador em
 * memória, mesmo com mutex, zeraria a cada reinício do container — e o recurso
 * protegido (a chave e o crédito do provedor) é externo ao processo.
 *
 * `day` é a data UTC em `YYYY-MM-DD`: a janela é o dia do calendário, não 24 h
 * corridas desde a primeira chamada, para o `Retry-After` ter um instante
 * previsível (meia-noite UTC).
 */
export interface DailyLlmBudgetStore {
  /**
   * Reserva uma chamada no dia `day` se ainda houver cota.
   *
   * @returns `true` quando a chamada entrou no orçamento; `false` quando o teto
   *   `limit` já foi atingido — e, nesse caso, nada é consumido.
   */
  tryReserve(day: string, limit: number): Promise<boolean>;
}
