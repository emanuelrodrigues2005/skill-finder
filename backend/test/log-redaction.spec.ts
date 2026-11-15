import { Writable } from 'node:stream';

import pino from 'pino';

import { pinoHttpOptions, REDACT_PATHS, REDACTED } from '@/common/logging/pino-options';
import { loadEnv } from '@/config/env.schema';

/**
 * Logger real com as opções que o processo usa (`pinoHttpOptions`), escrevendo num
 * stream em memória: o teste prova a redação de §8.5, não só a lista de paths.
 */
function captureLogger(): { logger: pino.Logger; output: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback: (error?: Error | null) => void): void {
      chunks.push(chunk.toString());
      callback();
    },
  });

  const options = pinoHttpOptions(loadEnv({ ENV: 'dev' }));
  const logger = pino({ level: 'debug', redact: options.redact }, stream);

  return { logger, output: () => chunks.join('') };
}

describe('log redaction (§8.5)', () => {
  it('builds a logger with every declared path (fast-redact rejects invalid paths)', () => {
    expect(REDACT_PATHS.length).toBeGreaterThan(0);
    expect(() => captureLogger()).not.toThrow();
  });

  it('turns authorization and cookie headers into [REDACTED]', () => {
    const { logger, output } = captureLogger();

    logger.info(
      {
        req: {
          headers: {
            authorization: 'Bearer sk-live-must-not-leak',
            cookie: 'sid=must-not-leak',
            'x-api-key': 'chave-must-not-leak',
            'x-admin-token': 'token-must-not-leak',
          },
        },
      },
      'request completed',
    );

    const line = output();

    expect(line).toContain(REDACTED);
    expect(line).not.toContain('sk-live-must-not-leak');
    expect(line).not.toContain('sid=must-not-leak');
    expect(line).not.toContain('chave-must-not-leak');
    expect(line).not.toContain('token-must-not-leak');
  });

  it('redacts the camelCase secrets of the config object (§3), at the root and nested', () => {
    const { logger, output } = captureLogger();

    logger.info(
      {
        llmApiKey: 'sk-root-must-not-leak',
        databaseUrl: 'postgresql://u:senha-must-not-leak@postgres:5432/skills',
        ipHashSalt: 'sal-must-not-leak',
        postgres: { password: 'senha-aninhada-must-not-leak' },
        config: {
          llmApiKey: 'sk-nested-must-not-leak',
          databaseUrl: 'postgresql://u:senha-nested-must-not-leak@postgres:5432/skills',
          ipHashSalt: 'sal-nested-must-not-leak',
          postgres: { password: 'senha-nested-must-not-leak' },
        },
      },
      'config loaded',
    );

    const line = output();

    expect(line).toContain(REDACTED);
    for (const secret of [
      'sk-root-must-not-leak',
      'senha-must-not-leak',
      'sal-must-not-leak',
      'senha-aninhada-must-not-leak',
      'sk-nested-must-not-leak',
      'senha-nested-must-not-leak',
      'sal-nested-must-not-leak',
    ]) {
      expect(line).not.toContain(secret);
    }
  });

  it('redacts the client IP that nginx forwards (§8.5: IP em claro é PII)', () => {
    const { logger, output } = captureLogger();

    logger.info(
      {
        req: {
          headers: { 'x-forwarded-for': '203.0.113.9', 'x-real-ip': '203.0.113.9' },
          remoteAddress: '203.0.113.9',
        },
      },
      'request completed',
    );

    expect(output()).not.toContain('203.0.113.9');
  });
});
