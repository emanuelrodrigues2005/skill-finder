import { Global, Injectable, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { type Env, ENV_KEYS, loadEnv } from './env.schema';

@Injectable()
export class AppConfigService {
  readonly env: Env;

  constructor(config: ConfigService) {
    const raw: Record<string, unknown> = {};
    for (const key of ENV_KEYS) {
      raw[key] = config.get<string>(key);
    }
    this.env = loadEnv(raw);
  }

  get isProd(): boolean {
    return this.env.env === 'prod';
  }
}

/**
 * Configuration module: `@nestjs/config` merges `.env` with the process
 * environment, and `AppConfigService` validates the result through the single zod
 * schema. Reading the values through `ConfigService` (instead of `process.env`)
 * keeps `.env` working for `pnpm start:dev` and for the compose `env_file`.
 */
@Global()
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, cache: true })],
  providers: [AppConfigService],
  exports: [ConfigModule, AppConfigService],
})
export class AppConfigModule {}
