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

  // --- catalog source (skills.sh) ---
  SKILL_SOURCE_KIND: z.enum(['json', 'html', 'fixture']).default('fixture'),
  SKILL_SOURCE_BASE_URL: z.string().min(1).optional(),
  SKILL_SOURCE_RPS: z.coerce.number().positive().default(1),

  // --- deterministic ranking weights (the LLM never orders anything) ---
  RANK_W_STARS: z.coerce.number().min(0).default(0.5),
  RANK_W_VULNS: z.coerce.number().min(0).default(0.3),
  RANK_W_INSTALLS: z.coerce.number().min(0).default(0.2),

  // --- per-client limits ---
  RATE_LIMIT_SEARCH_PER_MIN: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_SEARCH_PER_DAY: z.coerce.number().int().positive().default(60),

  // --- search history privacy ---
  SEARCH_LOG_STORE_TEXT: booleanFromEnv.default(false),
  IP_HASH_SALT: z.string().min(1).optional(),

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
    skillSourceKind: value.SKILL_SOURCE_KIND,
    skillSourceBaseUrl: value.SKILL_SOURCE_BASE_URL,
    skillSourceRps: value.SKILL_SOURCE_RPS,
    rankWStars: value.RANK_W_STARS,
    rankWVulns: value.RANK_W_VULNS,
    rankWInstalls: value.RANK_W_INSTALLS,
    rateLimitSearchPerMin: value.RATE_LIMIT_SEARCH_PER_MIN,
    rateLimitSearchPerDay: value.RATE_LIMIT_SEARCH_PER_DAY,
    searchLogStoreText: value.SEARCH_LOG_STORE_TEXT,
    ipHashSalt: value.IP_HASH_SALT,
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
