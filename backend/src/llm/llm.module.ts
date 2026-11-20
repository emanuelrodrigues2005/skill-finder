/**
 * Módulo do passo de intenção e do passo de explicação
 * (`docs/app/02-arquitetura.md` §3, §6.5 e §7.4).
 *
 * Quem decide o provedor é a configuração injetada, não o ambiente:
 * `enabled: false` (`LLM_ENABLED=false`, o modo degradado de dev/CI) entrega o
 * cliente `disabled`; `enabled: true` entrega o cliente OpenAI-compatible. O
 * provedor falso de teste entra por `overrideProvider(INTENT_PARSER)` /
 * `overrideProvider(EXPLAIN_PORT)` — regra 5 do `AGENTS.md`, que aposentou a
 * variável de provedor no env.
 *
 * As duas portas saem do **mesmo** cliente: um `axios` e um par de caches por
 * módulo, não dois. Construir o módulo não abre socket.
 */
import { type DynamicModule, Module } from '@nestjs/common';

import { skippedExplain, type ExplainParser, type ExplainResult } from './explain-parser';
import { lexicalIntent } from './intent-schema';
import type { IntentParser, IntentParserResult } from './intent-parser';
import { OpenAICompatParser } from './openai-compat';

/** Token de injeção da porta `IntentParser` (passo 4). */
export const INTENT_PARSER = 'INTENT_PARSER';

/** Token de injeção da porta `ExplainParser` (passo 7, §6.5). */
export const EXPLAIN_PORT = 'EXPLAIN_PORT';

/** Configuração do módulo; vem de `AppConfigService`, nunca lida aqui do ambiente. */
export interface LlmModuleOptions {
  /** `LLM_ENABLED`. */
  readonly enabled: boolean;
  /** `LLM_BASE_URL`, sem barra final. */
  readonly baseUrl: string;
  /** `LLM_MODEL`. */
  readonly model: string;
  /** `LLM_API_KEY`; ausente em dev/CI. */
  readonly apiKey?: string;
  /** `LLM_TIMEOUT_S`, em segundos. */
  readonly timeoutS: number;
  /** `LLM_TOTAL_DEADLINE_MS`; ausente vale o default de `env.schema.ts` (7000). */
  readonly totalDeadlineMs?: number;
}

/**
 * Modo `disabled` (§7.4): sem provedor, a intenção sai do fallback lexical e a
 * resposta é degradada; a explicação **não é tentada** (`explain_status: null`,
 * §6.3), e o texto vem do template determinístico do #42.
 *
 * Existe para que a busca nunca dependa da LLM para responder alguma coisa.
 */
class DisabledLlmClient implements IntentParser, ExplainParser {
  parse(query: string): Promise<IntentParserResult> {
    return Promise.resolve({
      intent: lexicalIntent(query),
      status: 'disabled',
      model: null,
      tokens: null,
    });
  }

  explain(): Promise<ExplainResult> {
    return Promise.resolve(skippedExplain('disabled'));
  }
}

@Module({})
export class LlmModule {
  /** Módulo dinâmico com as portas `INTENT_PARSER` e `EXPLAIN_PORT` resolvidas. */
  static forRoot(options: LlmModuleOptions): DynamicModule {
    const client = createLlmClient(options);
    return {
      module: LlmModule,
      providers: [
        { provide: INTENT_PARSER, useValue: client },
        { provide: EXPLAIN_PORT, useValue: client },
      ],
      exports: [INTENT_PARSER, EXPLAIN_PORT],
    };
  }
}

/**
 * Cliente que serve as duas portas, a partir das opções já resolvidas.
 *
 * Exportado para quem precisa da porta sem o módulo inteiro: o `SearchModule`
 * monta `INTENT_PARSER`/`EXPLAIN_PORT` em fábricas que injetam `AppConfigService`
 * (as opções só existem em runtime), e essas fábricas têm de decidir exatamente
 * como `forRoot` — duas cópias da regra "`enabled` escolhe o provedor" divergiriam
 * no primeiro ajuste.
 */
export function createLlmClient(options: LlmModuleOptions): IntentParser & ExplainParser {
  if (!options.enabled) {
    return new DisabledLlmClient();
  }
  return new OpenAICompatParser({
    baseUrl: options.baseUrl,
    model: options.model,
    apiKey: options.apiKey,
    timeoutS: options.timeoutS,
    totalDeadlineMs: options.totalDeadlineMs,
  });
}

/** Só a porta de intenção (compatibilidade com quem já monta `INTENT_PARSER`). */
export function createIntentParser(options: LlmModuleOptions): IntentParser {
  return createLlmClient(options);
}

/** Só a porta de explicação (o #42 monta a dela em `SearchModule`). */
export function createExplainParser(options: LlmModuleOptions): ExplainParser {
  return createLlmClient(options);
}
