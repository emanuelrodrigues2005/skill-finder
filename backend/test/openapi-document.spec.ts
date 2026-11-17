import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { NestApplicationContext } from '@nestjs/core';
import type { OpenAPIObject, OperationObject } from '@nestjs/swagger';
import { parse } from 'yaml';

import { buildOpenApiDocument } from '@/contract/openapi-document';

/**
 * Seam de documentação da issue #23: `buildOpenApiDocument()` é o **único** ponto
 * que gera o contrato, e tem dois chamadores — `scripts/generate-openapi.ts`
 * (escreve `openapi.yaml`) e `bootstrap()` (monta o Scalar em `/docs`, só fora de
 * produção). Estes casos olham o seam, não o grafo do documento: é a diferença
 * para `openapi-contract.spec.ts`, que abre o `OpenApiDocumentModule` à mão com
 * `overrideProvider(PrismaService)` e por isso nunca falharia se o seam passasse
 * a montar outro grafo (o `AppModule` sozinho, por exemplo, só tem três paths) ou
 * se deixasse a app efêmera aberta.
 *
 * Pontos de sutura exercitados aqui:
 * 1. o documento do seam é o contrato v0 completo (dez paths, cinco `x-internal`);
 * 2. o documento do seam é o artefato versionado (nada de `/docs` mentir);
 * 3. o seam fecha a app efêmera que criou;
 * 4. o seam não carrega o Scalar (o import é dinâmico, só no `bootstrap`);
 * 5. toda operação do contrato traz `description`.
 *
 * Não abre socket: o `nock.disableNetConnect()` do `test/setup.ts` continua
 * valendo e o `PrismaService` é substituído no registro de módulos, porque o seam
 * cria a app sozinho e não expõe um ponto de injeção.
 */

jest.mock('@/prisma/prisma.service', () => ({
  // Dublê do banco: o seam cria a app efêmera com `NestFactory.create`, então não
  // existe `overrideProvider` para usar; o `onModuleInit` do Prisma real tentaria
  // abrir TCP para o Postgres, que é justamente o que nenhum teste faz.
  PrismaService: class PrismaStub {
    ping(): Promise<boolean> {
      return Promise.resolve(true);
    }
  },
}));

jest.mock('@scalar/nestjs-api-reference', () => {
  // A factory só roda se alguém carregar o pacote. Marcar no global transforma
  // "o seam importa o Scalar no build" — estático ou dinâmico dentro de
  // `buildOpenApiDocument` — em falha nomeada no caso 5, em vez de um erro de
  // módulo que derruba o arquivo inteiro.
  (globalThis as Record<string, unknown>)['__openapi_document_spec_scalar_loaded'] = true;

  return {
    apiReference: () => {
      throw new Error('@scalar/nestjs-api-reference was used while building the document');
    },
    customThemeCSS: '',
  };
});

const OPENAPI_ARTIFACT = resolve(__dirname, '..', '..', 'openapi.yaml');

/** As dez rotas do contrato v0: sete sob o prefixo, três na raiz (`PUBLIC_ROUTES`). */
const EXPECTED_PATHS = [
  '/api/v1/admin/ingest',
  '/api/v1/admin/ingest/runs',
  '/api/v1/categories',
  '/api/v1/search',
  '/api/v1/searches/{request_id}',
  '/api/v1/skills',
  '/api/v1/skills/{skill_id}',
  '/healthz',
  '/metrics',
  '/readyz',
] as const;

/** As cinco operações `x-internal` do contrato (§5.1), independentes do artefato. */
const EXPECTED_INTERNAL_OPERATIONS = [
  'GET /api/v1/admin/ingest/runs',
  'GET /healthz',
  'GET /metrics',
  'GET /readyz',
  'POST /api/v1/admin/ingest',
] as const;

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

interface DocumentedOperation {
  /** `METHOD /path`, o formato que a mensagem de falha precisa mostrar. */
  key: string;
  operation: OperationObject;
}

function documentedOperations(doc: OpenAPIObject): DocumentedOperation[] {
  return Object.entries(doc.paths).flatMap(([path, item]) =>
    HTTP_METHODS.flatMap((method) => {
      const operation = item[method];
      return operation === undefined ? [] : [{ key: `${method.toUpperCase()} ${path}`, operation }];
    }),
  );
}

/** Extensões (`x-*`) não existem no tipo `OperationObject` do `@nestjs/swagger`. */
function extension(operation: OperationObject, name: string): unknown {
  return (operation as unknown as Record<string, unknown>)[name];
}

/** Descrição não vazia, ou `undefined` — o vazio não conta como documentado. */
function descriptionOf(operation: OperationObject): string | undefined {
  const value = operation.description;
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

describe('OpenAPI document seam (issue #23)', () => {
  let doc: OpenAPIObject;

  beforeAll(async () => {
    doc = await buildOpenApiDocument();
  });

  it('builds the contract document with the ten paths', () => {
    expect(Object.keys(doc.paths).sort()).toEqual([...EXPECTED_PATHS]);
  });

  it('matches the versioned artifact byte for byte', () => {
    // Comparação estrutural (YAML parseado) — bytes contra objeto não são
    // comparáveis, o que este caso prova é que o artefato commitado e o seam
    // falam do mesmo contrato: se `openapi.yaml` ficar para trás, o `/docs` do
    // seam o denuncia aqui, e não em produção.
    const artifact = parse(readFileSync(OPENAPI_ARTIFACT, 'utf8')) as OpenAPIObject;
    expect(doc).toEqual(artifact);
  });

  it('keeps the five internal operations', () => {
    const operations = documentedOperations(doc);

    // Uma operação por path: sem esta contagem, um `paths` inflado passaria só
    // porque o conjunto de `x-internal` continuaria igual.
    expect(operations.map(({ key }) => key)).toHaveLength(EXPECTED_PATHS.length);

    const internal = operations
      .filter(({ operation }) => extension(operation, 'x-internal') === true)
      .map(({ key }) => key)
      .sort();
    expect(internal).toEqual([...EXPECTED_INTERNAL_OPERATIONS]);
  });

  it('closes the ephemeral app it creates', async () => {
    // `NestApplicationContext.prototype.close` é a implementação única de
    // `close` (o `NestApplication` só sobrescreve `dispose`): espiar o protótipo
    // observa o efeito — "a app foi fechada" — sem acoplar o teste ao
    // `NestFactory` nem ao grafo interno do seam. Chamar duas vezes prova que
    // cada build fecha a **sua** app: um `close` esquecido deixaria a contagem
    // de closes atrás da de builds.
    const closeSpy = jest.spyOn(NestApplicationContext.prototype, 'close');
    try {
      const first = await buildOpenApiDocument();
      const second = await buildOpenApiDocument();

      expect(Object.keys(first.paths)).toHaveLength(EXPECTED_PATHS.length);
      expect(second).toEqual(first);
      expect({ builds: 2, closes: closeSpy.mock.calls.length }).toEqual({ builds: 2, closes: 2 });
    } finally {
      closeSpy.mockRestore();
    }
  });

  it('does not require the Scalar package', () => {
    // Se o seam importasse `@scalar/nestjs-api-reference` — estática ou
    // dinamicamente dentro de `buildOpenApiDocument` — a factory do `jest.mock`
    // acima teria rodado e deixado a marca; o documento ainda sai sem ela.
    expect(Object.keys(doc.paths)).toHaveLength(EXPECTED_PATHS.length);
    expect(
      (globalThis as Record<string, unknown>)['__openapi_document_spec_scalar_loaded'],
    ).toBeUndefined();
  });

  it('every operation documents a description', () => {
    const operations = documentedOperations(doc);
    const undocumented = operations
      .filter(({ operation }) => descriptionOf(operation) === undefined)
      .map(({ key }) => key);

    // A lista primeiro: a falha nomeia as operações sem descrição em vez de só
    // dizer "esperava 10".
    expect(undocumented).toEqual([]);
    expect(
      operations.filter(({ operation }) => descriptionOf(operation) !== undefined),
    ).toHaveLength(EXPECTED_PATHS.length);
  });
});
