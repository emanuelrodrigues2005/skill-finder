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

/**
 * Logger com as opções que o processo usa **incluindo `serializers`** (issue
 * #10): o `serializers.req` é o que decide o que do request vai para o log de
 * acesso, e ele é exercitado pelo caminho real do pino, não por uma cópia.
 */
function captureHttpLogger(): { logger: pino.Logger; output: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback: (error?: Error | null) => void): void {
      chunks.push(chunk.toString());
      callback();
    },
  });

  const options = pinoHttpOptions(loadEnv({ ENV: 'dev' }));
  const logger = pino(
    { level: 'debug', redact: options.redact, serializers: options.serializers },
    stream,
  );

  return { logger, output: () => chunks.join('') };
}

/**
 * Erro com a forma de um `AxiosError`: o axios anexa ao erro a configuração
 * inteira da requisição, e é por `config.headers.authorization` que a chave
 * vazaria para o log (§8.5).
 */
function axiosError(secret: string): Error {
  return Object.assign(new Error('request failed with status code 401'), {
    name: 'AxiosError',
    code: 'ERR_BAD_REQUEST',
    isAxiosError: true,
    config: {
      method: 'post',
      url: 'https://llm.test/v1/chat/completions',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    },
  });
}

describe('log redaction (§8.5)', () => {
  /**
   * Issue #10 (revisão): o permalink é **capability URL** — o `request_id` no
   * path é a credencial. O serializer padrão do pino-http loga `url` (e o
   * Express expõe `params`), então `serializers.req` os descarta; os headers
   * continuam, porque a redação de §8.5 é justamente sobre eles.
   */
  it('drops url/params from the request serializer and keeps headers redacted (issue #10)', () => {
    const capabilityId = 'req_01JCV8Y6Q4CAPABILITYURL0000';
    const serverRequestId = 'b0d1f3a2-7c1e-4a55-9f0e-2d4a1c6b8e11';
    const { logger, output } = captureHttpLogger();

    logger.info(
      {
        req: {
          id: serverRequestId,
          method: 'GET',
          url: `/api/v1/searches/${capabilityId}`,
          params: { request_id: capabilityId },
          headers: {
            authorization: 'Bearer sk-live-must-not-leak',
            cookie: 'sid=must-not-leak',
            accept: 'application/json',
          },
        },
      },
      'request completed',
    );

    const line = output();

    // A credencial do permalink não chega ao log de acesso.
    expect(line).not.toContain(capabilityId);
    expect(line).not.toContain('/api/v1/searches/');
    expect(line).not.toContain('"url"');
    expect(line).not.toContain('"params"');
    // O que identifica o request continua lá: o teste não passa por linha vazia.
    expect(line).toContain(serverRequestId);
    expect(line).toContain('"method":"GET"');
    expect(line).toContain('"accept":"application/json"');
    // E a redação de §8.5 continua valendo dentro do objeto serializado.
    expect(line).toContain(REDACTED);
    expect(line).not.toContain('sk-live-must-not-leak');
    expect(line).not.toContain('sid=must-not-leak');
  });

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
          adminToken: 'admin-token-must-not-leak',
        postgres: { password: 'senha-aninhada-must-not-leak' },
        config: {
          llmApiKey: 'sk-nested-must-not-leak',
          databaseUrl: 'postgresql://u:senha-nested-must-not-leak@postgres:5432/skills',
          ipHashSalt: 'sal-nested-must-not-leak',
            adminToken: 'admin-token-nested-must-not-leak',
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

  it('redacts the client IP that the edge forwards (§8.5: IP em claro é PII)', () => {
    const { logger, output } = captureLogger();

    logger.info(
      {
        req: {
          headers: {
            'x-forwarded-for': '203.0.113.9',
            // ADR-015: o ALB não escreve este header, então ele chega como o
            // cliente mandou. Deixou de ser lido pela identidade e continua
            // redigido — o valor é escolhido por quem faz a requisição.
            'x-real-ip': '198.51.100.7',
          },
          remoteAddress: '203.0.113.9',
        },
      },
      'request completed',
    );

    expect(output()).not.toContain('203.0.113.9');
    expect(output()).not.toContain('198.51.100.7');
  });

  /**
   * F4: o erro do axios carrega a requisição inteira em `config`, header
   * `authorization` incluído. `REDACT_PATHS` declara três aninhamentos possíveis
   * (`err.config.…`, `*.config.…`, `*.headers.…`); este caso exercita os três no
   * logger real, porque um path declarado e inerte é indistinguível de um path
   * que protege.
   */
  it('redacts the axios error authorization header at every depth', () => {
    const secret = 'sk-axios-must-not-leak';
    const message = 'intent call failed: upstream 401';
    const payloads: Array<{ name: string; payload: Record<string, unknown> }> = [
      { name: 'err.config.headers.authorization', payload: { err: axiosError(secret) } },
      {
        name: '*.config.headers.authorization',
        payload: { failure: { config: { headers: { authorization: `Bearer ${secret}` } } } },
      },
      {
        name: '*.headers.authorization',
        payload: { upstream: { headers: { authorization: `Bearer ${secret}` } } },
      },
    ];

    const leaks: string[] = [];
    const noCensor: string[] = [];
    const noControl: string[] = [];

    for (const { name, payload } of payloads) {
      const { logger, output } = captureLogger();
      logger.error(payload, message);
      const line = output();

      if (line.includes(secret)) {
        leaks.push(name);
      }
      // A censura precisa aparecer: prova que o caminho existe e censurou, e não
      // que o pino descartou o payload inteiro (o que também esconderia o segredo).
      if (!line.includes(REDACTED)) {
        noCensor.push(name);
      }
      // Controle negativo: o que não é segredo sobrevive ao mesmo payload.
      if (!line.includes(message)) {
        noControl.push(name);
      }
    }

    expect(leaks).toEqual([]);
    expect(noCensor).toEqual([]);
    expect(noControl).toEqual([]);
  });
});
