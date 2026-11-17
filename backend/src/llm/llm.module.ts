/**
 * Módulo do passo de intenção (`docs/app/02-arquitetura.md` §3 e §7.4).
 *
 * Quem decide o provedor é a configuração injetada, não o ambiente:
 * `enabled: false` (`LLM_ENABLED=false`, o modo degradado de dev/CI) entrega o
 * parser `disabled`; `enabled: true` entrega o cliente OpenAI-compatible. O
 * provedor falso de teste entra por `overrideProvider(INTENT_PARSER)` — regra 5
 * do `AGENTS.md`, que aposentou a variável de provedor no env.
 *
 * Este módulo não é registrado em `app.module.ts` ainda: quem monta a busca
 * (F2.6) chama `LlmModule.forRoot` com os valores de `AppConfigService` e é o
 * dono do token. Construir o módulo não abre socket.
 */
import { type DynamicModule, Module } from '@nestjs/common';

import { lexicalIntent } from './intent-schema';
import type { IntentParser, IntentParserResult } from './intent-parser';
import { OpenAICompatParser } from './openai-compat';

/** Token de injeção da porta `IntentParser`. */
export const INTENT_PARSER = 'INTENT_PARSER';

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
}

/**
 * Modo `disabled` (§7.4): sem provedor, a intenção sai do fallback lexical e a
 * resposta é degradada. Existe para que a busca nunca dependa da LLM para
 * responder alguma coisa.
 */
class DisabledIntentParser implements IntentParser {
  parse(query: string): Promise<IntentParserResult> {
    return Promise.resolve({
      intent: lexicalIntent(query),
      status: 'disabled',
      model: null,
      tokens: null,
    });
  }
}

@Module({})
export class LlmModule {
  /** Módulo dinâmico com a porta `INTENT_PARSER` resolvida a partir de `options`. */
  static forRoot(options: LlmModuleOptions): DynamicModule {
    return {
      module: LlmModule,
      providers: [
        {
          provide: INTENT_PARSER,
          useFactory: (): IntentParser => createIntentParser(options),
        },
      ],
      exports: [INTENT_PARSER],
    };
  }
}

function createIntentParser(options: LlmModuleOptions): IntentParser {
  if (!options.enabled) {
    return new DisabledIntentParser();
  }
  return new OpenAICompatParser({
    baseUrl: options.baseUrl,
    model: options.model,
    apiKey: options.apiKey,
    timeoutS: options.timeoutS,
  });
}
