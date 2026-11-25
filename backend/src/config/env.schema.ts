/**
 * Single source of configuration (`docs/app/02-arquitetura.md` §3).
 *
 * This is the only module allowed to touch `process.env`: everything else reads
 * `AppConfigService`. In `ENV=prod` the schema refuses to load when a required
 * value is missing, so the process dies at boot instead of at the first query.
 * `NODE_ENV=production` with `ENV!=prod` is refused too: the runtime image ships
 * `NODE_ENV=production`, so a "prod" container booting in dev mode is a bug, not
 * a preference.
 */
import { z } from 'zod';

export const DEFAULT_LLM_BASE_URL = 'https://opencode.ai/inference/go/openai/v1';
export const DEFAULT_LLM_MODEL = 'deepseek-v4.1-flash';
/**
 * Teto de tempo **somado** das chamadas de LLM numa busca (F2.10): intenção
 * (`min(3000, restante)`) + explicação (`min(4000, restante)`). Estourado, o
 * passo pendente cai no fallback e a resposta degrada; com menos de 800 ms
 * restantes a explicação nem é tentada.
 */
export const DEFAULT_LLM_TOTAL_DEADLINE_MS = 7_000;

/**
 * Teto de tempo de **uma rodada** de enriquecimento ao vivo (ms).
 *
 * A rodada roda em segundo plano (fase 1 da auditoria de latência: ela não está
 * mais no caminho da resposta), então este teto não protege o request — protege o
 * processo, porque a rodada pendurada seguraria o single-flight e nada mais seria
 * enriquecido. 60 s cobrem o sitemap (2–3 s) mais 12 chaves a 1 req/s (~12 s) com
 * folga para fonte lenta.
 */
export const DEFAULT_LIVE_ENRICH_BUDGET_MS = 60_000;

/** Default do `compose.yaml` para a árvore limpa validar sem `.env`; proibido em prod. */
export const DEV_DEFAULT_DB_PASSWORD = 'skillsdev';

// Aceita `true`/`false` (string de env, com qualquer caixa) e também boolean já
// convertido — que é o que chega quando o `.default()` é aplicado. Comparar só
// com a string `'true'` transformava o default booleano `true` em `false`.
const booleanFromEnv = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
  z.union([z.boolean(), z.enum(['true', 'false'])]).transform((value) => value === true || value === 'true'),
);

const postgresUrl = z
  .string()
  .min(1)
  .refine(
    (value) => value.startsWith('postgresql://') || value.startsWith('postgres://'),
    'must start with postgresql:// (Prisma does not accept driver suffixes)',
  );

const baseEnvSchema = z.object({
  // --- runtime ---
  ENV: z.enum(['dev', 'prod']).default('dev'),
  // Só existe para a guarda abaixo: a imagem de runtime nasce com
  // `NODE_ENV=production`, então o par (NODE_ENV, ENV) precisa concordar.
  NODE_ENV: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // --- database ---
  DATABASE_URL: postgresUrl.optional(),

  // --- LLM (OpenAI-compatible, via opencode) ---
  LLM_BASE_URL: z.string().min(1).default(DEFAULT_LLM_BASE_URL),
  LLM_MODEL: z.string().min(1).default(DEFAULT_LLM_MODEL),
  LLM_API_KEY: z.string().min(1).optional(),
  LLM_ENABLED: booleanFromEnv.default(true),
  LLM_TIMEOUT_S: z.coerce.number().positive().default(8),
  // F2.10: orçamento total de latência da LLM numa busca. `positive()` porque um
  // teto de 0 ms faria toda busca degradar sem tentar, em silêncio.
  LLM_TOTAL_DEADLINE_MS: z.coerce.number().int().positive().default(DEFAULT_LLM_TOTAL_DEADLINE_MS),
  // #35: teto **global** de chamadas da LLM por dia UTC. Opcional — ausente, não
  // há teto e o comportamento é o de antes da issue. `positive()` porque um teto
  // de 0 chamadas desligaria a LLM em silêncio, escondido num número; para isso
  // existe `LLM_ENABLED=false`, que é explícito.
  LLM_DAILY_CALL_BUDGET: z.coerce.number().int().positive().optional(),

  // --- catalog source (skills.sh) ---
  // #47: `json` saiu — não existe endpoint JSON público (`/api/` é proibido pelo
  // robots do site; D3 em `docs/app/amostras/README.md`). As fontes reais são o
  // adaptador `html` e a fixture congelada.
  SKILL_SOURCE_KIND: z.enum(['html', 'fixture']).default('fixture'),
  SKILL_SOURCE_BASE_URL: z.string().min(1).optional(),
  SKILL_SOURCE_RPS: z.coerce.number().positive().default(1),
  //
  // Enriquecimento ao vivo: quando a busca local nao devolve nada, enumera o
  // sitemap, filtra as chaves pelo slug e ingere ate N delas. Desligado por padrao
  // porque custa requisicoes contra a fonte. A rodada NAO entra mais no caminho da
  // resposta (fase 1 da auditoria de latencia): ela roda em segundo plano, entao o
  // teto de tempo protege o processo, nao o request.
  LIVE_ENRICH_ENABLED: booleanFromEnv.default(false),
  LIVE_ENRICH_MAX_KEYS: z.coerce.number().int().positive().default(12),
  //
  // Cota entre rodadas do enriquecimento ao vivo. O single-flight impede duas
  // rodadas simultaneas, mas nao uma atras da outra: sem este intervalo, cada
  // busca vazia abriria uma rodada de ate 12 requisicoes contra a fonte, a partir
  // de input publico (amplificacao). 60 s limita a 12 req/min por processo.
  LIVE_ENRICH_MIN_INTERVAL_MS: z.coerce.number().int().nonnegative().default(60_000),
  // Orcamento de UMA rodada. `positive()` porque um teto de 0 ms abandonaria toda
  // rodada antes de pedir a primeira chave — enriquecimento que nunca enriquece.
  LIVE_ENRICH_BUDGET_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_LIVE_ENRICH_BUDGET_MS),

  // --- deterministic ranking weights (the LLM never orders anything) ---
  RANK_W_STARS: z.coerce.number().min(0).default(0.5),
  RANK_W_VULNS: z.coerce.number().min(0).default(0.3),
  RANK_W_INSTALLS: z.coerce.number().min(0).default(0.2),

  // --- per-client limits ---
  RATE_LIMIT_SEARCH_PER_MIN: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_SEARCH_PER_DAY: z.coerce.number().int().positive().default(60),

  // --- search history privacy ---
  // `SEARCH_LOG_STORE_TEXT` não existe mais: o texto da consulta é guardado
  // sempre, porque a resposta o devolve em `query` — inclusive no permalink, que
  // não tem o cliente para perguntar de novo. O que continua restrito é o IP:
  // o histórico só carrega `client_hash` com sal (§8.5).
  IP_HASH_SALT: z.string().min(1).optional(),

  // --- admin ingestion (#49) ---
  // Token do header `X-Admin-Token` de `POST /admin/ingest` (§5.1, §8.1): é o
  // único endpoint que **escreve** no catálogo, então a rota falha fechada —
  // sem token configurado ela responde 401, nunca fica aberta. Em dev é
  // opcional (quem opera local define no `.env`); em prod o boot recusa.
  // `.min(32)`: a rota nao tem rate limit de tentativas, entao um token de
  // dicionario seria brute-forcavel online - a comparacao tempo-constante
  // protege contra oraculo de BYTES, nao contra espaco de busca pequeno.
  // Gere com `openssl rand -hex 32`.
  ADMIN_TOKEN: z.string().min(32).optional(),

  // --- compose-only (docker-compose derives DATABASE_URL from these) ---
  POSTGRES_USER: z.string().min(1).optional(),
  POSTGRES_PASSWORD: z.string().optional(),
  POSTGRES_DB: z.string().min(1).optional(),
});

export type EnvKey = keyof z.infer<typeof baseEnvSchema>;

/** Every variable name the app knows about; used to read the merged env once. */
export const ENV_KEYS: readonly EnvKey[] = Object.keys(
  baseEnvSchema.shape,
) as readonly EnvKey[];

export const envSchema = baseEnvSchema
  .superRefine((value, ctx) => {
    // `NODE_ENV=production` com `ENV=dev` é o modo "prod que subiu em dev":
    // desliga Swagger-off, CORS restrito e as checagens de produção. Um `.env`
    // copiado do exemplo (`ENV=` vazio) cairia exatamente aqui.
    if (value.NODE_ENV === 'production' && value.ENV !== 'prod') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ENV'],
        message:
          'must be "prod" when NODE_ENV=production (a dev ENV disables Swagger-off, ' +
          'the restricted CORS and the prod validation; the compose prod profile sets ENV=prod)',
      });
    }
    if (value.ENV !== 'prod') {
      return;
    }
    const missing: EnvKey[] = [];
    if (!value.DATABASE_URL) {
      missing.push('DATABASE_URL');
    }
    if (value.LLM_ENABLED && !value.LLM_API_KEY) {
      missing.push('LLM_API_KEY');
    }
    // §8.5: hash de IPv4 sem sal é reversível por tabela (2³²), ou seja, IP em
    // claro no histórico de busca. Em prod o sal é obrigatório.
    if (!value.IP_HASH_SALT) {
      missing.push('IP_HASH_SALT');
    }
    // #49: sem `ADMIN_TOKEN` a rota de ingestão responderia 401 para sempre (o
    // guard falha fechado) — em prod isso é uma API que não pode mais popular o
    // catálogo. Recusar no boot é melhor do que descobrir no primeiro run.
    if (!value.ADMIN_TOKEN) {
      missing.push('ADMIN_TOKEN');
    }
    for (const key of missing) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `required when ENV=prod (set ${key} in .env or Infisical)`,
      });
    }
    // O `compose.yaml` usa `skillsdev` como default para a árvore limpa validar sem
    // `.env`. Em prod esse default é proibido: banco com senha conhecida não sobe.
    if (value.DATABASE_URL?.includes(`:${DEV_DEFAULT_DB_PASSWORD}@`)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DATABASE_URL'],
        message: `must not use the dev default password (${DEV_DEFAULT_DB_PASSWORD}) when ENV=prod`,
      });
    }
  })
  .transform((value) => ({
    env: value.ENV,
    logLevel: value.LOG_LEVEL,
    databaseUrl: value.DATABASE_URL,
    llmBaseUrl: value.LLM_BASE_URL,
    llmModel: value.LLM_MODEL,
    llmApiKey: value.LLM_API_KEY,
    llmEnabled: value.LLM_ENABLED,
    llmTimeoutS: value.LLM_TIMEOUT_S,
    llmTotalDeadlineMs: value.LLM_TOTAL_DEADLINE_MS,
    llmDailyCallBudget: value.LLM_DAILY_CALL_BUDGET,
    skillSourceKind: value.SKILL_SOURCE_KIND,
    skillSourceBaseUrl: value.SKILL_SOURCE_BASE_URL,
    skillSourceRps: value.SKILL_SOURCE_RPS,
    liveEnrichEnabled: value.LIVE_ENRICH_ENABLED,
    liveEnrichMaxKeys: value.LIVE_ENRICH_MAX_KEYS,
    liveEnrichMinIntervalMs: value.LIVE_ENRICH_MIN_INTERVAL_MS,
    liveEnrichBudgetMs: value.LIVE_ENRICH_BUDGET_MS,
    rankWStars: value.RANK_W_STARS,
    rankWVulns: value.RANK_W_VULNS,
    rankWInstalls: value.RANK_W_INSTALLS,
    rateLimitSearchPerMin: value.RATE_LIMIT_SEARCH_PER_MIN,
    rateLimitSearchPerDay: value.RATE_LIMIT_SEARCH_PER_DAY,
    ipHashSalt: value.IP_HASH_SALT,
    adminToken: value.ADMIN_TOKEN,
    postgres: {
      user: value.POSTGRES_USER,
      password: value.POSTGRES_PASSWORD,
      database: value.POSTGRES_DB,
    },
  }));

export type Env = z.infer<typeof envSchema>;

/**
 * Validates the environment and returns the typed config.
 *
 * Empty strings count as absent, so a `.env` copied from `.env.example` keeps the
 * defaults instead of failing on `LLM_TIMEOUT_S=`.
 */
export function loadEnv(raw: Record<string, unknown> = process.env): Env {
  const parsed = envSchema.safeParse(dropEmptyStrings(raw));
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return parsed.data;
}

function dropEmptyStrings(raw: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(raw).filter(([, value]) => !(typeof value === 'string' && value.trim() === '')),
  );
}
