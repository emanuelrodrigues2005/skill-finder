/**
 * Porta do passo de intenção (`docs/app/02-arquitetura.md` §6.3).
 *
 * A LLM interpreta a consulta e devolve uma `Intent`; ela **nunca** ranqueia: a
 * ordem sai de `backend/src/ranking` (regra 1 do `AGENTS.md`). Por isso o
 * resultado desta porta não carrega `score`, pesos nem candidatos — só a
 * intenção, o `status` do passo e o que foi cobrado do provedor.
 *
 * A porta é o único ponto que o domínio conhece: o provedor real
 * (`OpenAICompatParser`), o falso de teste (`FakeIntentParser`) e o modo
 * `disabled` entram por injeção de dependência (regra 5).
 */
import type { Intent, LlmStatus, TokenUsage } from '@/contract/dto/search-response.dto';

/** O que o passo de intenção devolve para a busca. */
export interface IntentParserResult {
  readonly intent: Intent;
  /**
   * Termos em inglês para o `tsquery` do `search_doc` (issue #40).
   *
   * Fica **fora** da `Intent` de propósito: o contrato público (`openapi.yaml`)
   * não muda, e este campo só serve ao recuperador. Ausente ou vazio, quem
   * consome cai em `intent.keywords` — a busca nunca fica sem termo.
   */
  readonly keywordsEn?: readonly string[];
  readonly status: LlmStatus;
  /** Modelo que respondeu; `null` quando não houve chamada ao provedor. */
  readonly model: string | null;
  /** Tokens cobrados; `null` quando não houve chamada ao provedor. */
  readonly tokens: TokenUsage | null;
}

/** Porta injetada em quem precisa de uma intenção a partir do texto do usuário. */
export interface IntentParser {
  parse(query: string, categories: readonly string[]): Promise<IntentParserResult>;
}
