import type { ConfigService } from '@nestjs/config';

import { AppConfigService } from '@/config/config.module';
import { loadEnv } from '@/config/env.schema';

/** Mesma leitura que o `ConfigService` do Nest faz (valor por chave, ou ausente). */
function configFrom(raw: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => raw[key] } as unknown as ConfigService;
}

describe('env schema (§3)', () => {
  it('applies the documented defaults in dev', () => {
    const env = loadEnv({ ENV: 'dev' });

    expect(env.env).toBe('dev');
    expect(env.logLevel).toBe('info');
    expect(env.databaseUrl).toBeUndefined();
    expect(env.llmBaseUrl).toBe('https://opencode.ai/inference/go/openai/v1');
    expect(env.llmModel).toBe('deepseek-v4.1-flash');
    expect(env.llmEnabled).toBe(true);
    expect(env.llmTimeoutS).toBe(8);
    expect(env.skillSourceKind).toBe('fixture');
    expect(env.skillSourceRps).toBe(1);
    expect(env.rankWStars).toBe(0.5);
    expect(env.rankWVulns).toBe(0.3);
    expect(env.rankWInstalls).toBe(0.2);
    expect(env.rateLimitSearchPerMin).toBe(10);
    expect(env.rateLimitSearchPerDay).toBe(60);
    expect(env.searchLogStoreText).toBe(false);
  });

  it('exposes LLM_TOTAL_DEADLINE_MS with the ratified 7000 ms default', () => {
    // Plano F2.10: teto de tempo *somado* das chamadas de LLM numa busca. A
    // intenção recebe min(3000, restante) e a explicação min(4000, restante).
    expect(loadEnv({ ENV: 'dev' }).llmTotalDeadlineMs).toBe(7000);
    expect(loadEnv({ ENV: 'dev', LLM_TOTAL_DEADLINE_MS: '9000' }).llmTotalDeadlineMs).toBe(9000);
    expect(() => loadEnv({ ENV: 'dev', LLM_TOTAL_DEADLINE_MS: '0' })).toThrow(
      /LLM_TOTAL_DEADLINE_MS/,
    );
  });

  it('treats empty strings from .env.example as absent', () => {
    const env = loadEnv({ ENV: 'dev', LLM_TIMEOUT_S: '', RANK_W_STARS: '   ', DATABASE_URL: '' });

    expect(env.llmTimeoutS).toBe(8);
    expect(env.rankWStars).toBe(0.5);
    expect(env.databaseUrl).toBeUndefined();
  });

  it('parses booleans and numbers as strings, as they arrive from the environment', () => {
    const env = loadEnv({
      ENV: 'dev',
      LLM_ENABLED: 'FALSE',
      SEARCH_LOG_STORE_TEXT: 'true',
      RATE_LIMIT_SEARCH_PER_MIN: '3',
    });

    expect(env.llmEnabled).toBe(false);
    expect(env.searchLogStoreText).toBe(true);
    expect(env.rateLimitSearchPerMin).toBe(3);
  });

  it('rejects unknown enum values and non-positive limits', () => {
    expect(() => loadEnv({ ENV: 'staging' })).toThrow(/ENV/);
    expect(() => loadEnv({ SKILL_SOURCE_KIND: 'xml' })).toThrow(/SKILL_SOURCE_KIND/);
    expect(() => loadEnv({ RATE_LIMIT_SEARCH_PER_MIN: '0' })).toThrow(
      /RATE_LIMIT_SEARCH_PER_MIN/,
    );
    expect(() => loadEnv({ DATABASE_URL: 'mysql://u:p@host/db' })).toThrow(/DATABASE_URL/);
  });

  describe('fails at boot in prod', () => {
    it('without DATABASE_URL', () => {
      expect(() => loadEnv({ ENV: 'prod', LLM_ENABLED: 'true' })).toThrow(/DATABASE_URL/);
    });

    it('without LLM_API_KEY while the LLM is enabled', () => {
      expect(() =>
        loadEnv({ ENV: 'prod', DATABASE_URL: 'postgresql://u:p@postgres:5432/skills' }),
      ).toThrow(/LLM_API_KEY/);
    });

    it('without LLM_API_KEY but with the LLM disabled is allowed', () => {
      const env = loadEnv({
        ENV: 'prod',
        DATABASE_URL: 'postgresql://u:p@postgres:5432/skills',
        LLM_ENABLED: 'false',
        IP_HASH_SALT: 'sal-de-teste',
      });

      expect(env.llmApiKey).toBeUndefined();
      expect(env.llmEnabled).toBe(false);
    });

    it('without IP_HASH_SALT (hash de IPv4 sem sal é IP em claro)', () => {
      expect(() =>
        loadEnv({
          ENV: 'prod',
          DATABASE_URL: 'postgresql://u:p@postgres:5432/skills',
          LLM_ENABLED: 'false',
        }),
      ).toThrow(/IP_HASH_SALT/);
    });

    it('with an empty DATABASE_URL (empty means absent)', () => {
      expect(() => loadEnv({ ENV: 'prod', DATABASE_URL: ' ', LLM_ENABLED: 'false' })).toThrow(
        /DATABASE_URL/,
      );
    });
  });

  describe('refuses a production container that booted in dev mode', () => {
    it('rejects NODE_ENV=production with ENV=dev', () => {
      expect(() => loadEnv({ NODE_ENV: 'production', ENV: 'dev' })).toThrow(/must be "prod"/);
    });

    it('rejects NODE_ENV=production with ENV unset (default is dev)', () => {
      expect(() => loadEnv({ NODE_ENV: 'production' })).toThrow(/must be "prod"/);
    });

    it('accepts NODE_ENV=production with ENV=prod and the prod secrets', () => {
      const env = loadEnv({
        NODE_ENV: 'production',
        ENV: 'prod',
        DATABASE_URL: 'postgresql://u:p@postgres:5432/skills',
        LLM_ENABLED: 'false',
        IP_HASH_SALT: 'sal-de-teste',
      });

      expect(env.env).toBe('prod');
    });
  });

  // O compose usa `skillsdev` como default para `config` validar sem `.env`.
  // Em prod esse default não pode subir: senha conhecida em banco de produção.
  describe('refuses the compose dev default password in production', () => {
    it('rejects DATABASE_URL carrying the dev default password when ENV=prod', () => {
      expect(() =>
        loadEnv({
          ENV: 'prod',
          DATABASE_URL: 'postgresql://skills:skillsdev@postgres:5432/skills?schema=public',
          LLM_ENABLED: 'false',
          IP_HASH_SALT: 'sal-de-teste',
        }),
      ).toThrow(/dev default password/);
    });

    it('accepts a real password in production', () => {
      const env = loadEnv({
        ENV: 'prod',
        DATABASE_URL: 'postgresql://skills:S3nh4-real@postgres:5432/skills?schema=public',
        LLM_ENABLED: 'false',
        IP_HASH_SALT: 'sal-de-teste',
      });

      expect(env.env).toBe('prod');
    });
  });

  it('AppConfigService — the class instantiated at boot — throws on missing prod secrets', () => {
    expect(() => new AppConfigService(configFrom({ ENV: 'prod' }))).toThrow(
      /Invalid environment configuration/,
    );
    expect(() => new AppConfigService(configFrom({ ENV: 'prod', DATABASE_URL: 'postgresql://u:p@h/d' }))).toThrow(
      /LLM_API_KEY/,
    );
  });

  it('AppConfigService exposes a validated, typed config', () => {
    const config = new AppConfigService(
      configFrom({ ENV: 'dev', RANK_W_VULNS: '0.4', POSTGRES_USER: 'skills' }),
    );

    expect(config.isProd).toBe(false);
    expect(config.env.rankWVulns).toBe(0.4);
    expect(config.env.postgres).toEqual({
      user: 'skills',
      password: undefined,
      database: undefined,
    });
  });
});
