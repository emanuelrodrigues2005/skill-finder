/**
 * Issue #9 (F2.5) — injeção de dependência: quem decide o provedor e a configuracao, nao o env.
 *
 * Contrato exigido do codigo de producao (`backend/src/llm/llm.module.ts`):
 *
 *   export const INTENT_PARSER: string;            // token de injeção da porta
 *   export interface LlmModuleOptions {
 *     enabled: boolean;                            // LLM_ENABLED
 *     baseUrl: string;                             // LLM_BASE_URL
 *     model: string;                               // LLM_MODEL
 *     apiKey?: string;                             // LLM_API_KEY
 *     timeoutS: number;                            // LLM_TIMEOUT_S
 *   }
 *   export class LlmModule {
 *     static forRoot(options: LlmModuleOptions): DynamicModule;
 *   }
 *
 * Regras ratificadas: `LLM_ENABLED=false` -> parser `disabled` (modo degradado de dev/CI, §7.4);
 * `LLM_ENABLED=true` -> cliente OpenAI-compat; o provedor falso entra **so** por DI (override de
 * `INTENT_PARSER`), nunca por `LLM_PROVIDER` — essa variavel nao existe em `env.schema.ts`
 * (regra 5 do AGENTS.md). Construir o modulo nao abre socket.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { Test } from '@nestjs/testing';

import type { Intent } from '@/contract/dto/search-response.dto';
import { FakeIntentParser } from '@/llm/fake';
import type { IntentParser } from '@/llm/intent-parser';
import { INTENT_PARSER, LlmModule } from '@/llm/llm.module';
import { OpenAICompatParser } from '@/llm/openai-compat';
import type { LlmModuleOptions } from '@/llm/llm.module';

const OPTIONS: LlmModuleOptions = {
  enabled: true,
  baseUrl: 'https://llm.test/v1',
  model: 'deepseek-v4.1-flash',
  apiKey: 'sk-test-not-a-real-key',
  timeoutS: 8,
};

const STUB_INTENT: Intent = {
  category: null,
  keywords: ['stub'],
  filters: { exclude_with_vulnerabilities: false },
  language: 'en',
  confidence: 0.9,
};

async function build(options: Partial<LlmModuleOptions>): Promise<IntentParser> {
  const moduleRef = await Test.createTestingModule({
    imports: [LlmModule.forRoot({ ...OPTIONS, ...options })],
  }).compile();
  return moduleRef.get<IntentParser>(INTENT_PARSER);
}

describe('llm module (docs/app/02-arquitetura.md 3 e 7.4)', () => {
  it('LLM_ENABLED=false yields disabled', async () => {
    const parser = await build({ enabled: false });

    const result = await parser.parse('review python pull requests', ['security']);

    expect(result.status).toBe('disabled');
    expect(result.intent.category).toBeNull();
    expect(result.intent.keywords.length).toBeGreaterThan(0);
    expect(result.model).toBeNull();
    expect(result.tokens).toBeNull();
  });

  it('LLM_ENABLED=true yields the openai-compat parser', async () => {
    // Construir nao abre socket: se abrisse, `nock.disableNetConnect()` derrubaria a suite.
    const parser = await build({ enabled: true });

    expect(parser).toBeInstanceOf(OpenAICompatParser);
  });

  it('the fake is injected by DI, never by env', async () => {
    // (a) `LLM_PROVIDER` nao existe mais no schema de ambiente.
    const envSource = readFileSync(
      join(__dirname, '..', '..', 'src', 'config', 'env.schema.ts'),
      'utf8',
    );
    expect(envSource).not.toMatch(/LLM_PROVIDER/);

    // (b) nada em `src/llm` le `process.env`: configuracao entra por DI.
    const llmDir = join(__dirname, '..', '..', 'src', 'llm');
    const sources = readdirSync(llmDir, { recursive: true }).filter(
      (entry): entry is string => typeof entry === 'string' && entry.endsWith('.ts'),
    );
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(readFileSync(join(llmDir, source), 'utf8')).not.toMatch(/process\.env/);
    }

    // (c) o provedor falso substitui o real por DI, sem tocar no env.
    const fake = new FakeIntentParser([{ query: 'review python pull requests', intent: STUB_INTENT }]);
    const moduleRef = await Test.createTestingModule({
      imports: [LlmModule.forRoot(OPTIONS)],
    })
      .overrideProvider(INTENT_PARSER)
      .useValue(fake)
      .compile();

    expect(moduleRef.get(INTENT_PARSER)).toBe(fake);
    expect(moduleRef.get<IntentParser>(INTENT_PARSER)).not.toBeInstanceOf(OpenAICompatParser);
  });
});
