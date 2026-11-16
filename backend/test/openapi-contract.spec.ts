import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import type {
  OpenAPIObject,
  OperationObject,
  ParameterObject,
  PathItemObject,
  ReferenceObject,
  RequestBodyObject,
  ResponseObject,
  SchemaObject,
} from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { parse } from 'yaml';

import { ERROR_CODES } from '@/common/errors/error-codes';
import { OpenApiDocumentModule } from '@/contract/openapi-document.module';
import { applyGlobalPrefix, openApiOptions } from '@/main';
import { PrismaService } from '@/prisma/prisma.service';

/**
 * Contrato OpenAPI v0 da milestone F2 (issue #5). Fonte de verdade:
 * `docs/app/02-arquitetura.md` §5 — os nomes, status e códigos daqui são decisões
 * ratificadas pelo architect; renomear qualquer um deles é mudança de contrato.
 *
 * O documento é gerado com os mesmos exports que `scripts/generate-openapi.ts`
 * usa (`applyGlobalPrefix` + `openApiOptions`), e o `PrismaService` é trocado por
 * um dublê: o teste não abre socket para o Postgres e o
 * `nock.disableNetConnect()` do `test/setup.ts` continua valendo.
 */
const OPENAPI_ARTIFACT = resolve(__dirname, '..', '..', 'openapi.yaml');

const ERROR_ENVELOPE_REF = '#/components/schemas/ErrorEnvelope';

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

interface ExpectedStatuses {
  /** Códigos 2xx aceitos; o `POST /admin/ingest` pode ser 200 ou 202 (§5.1). */
  success: number[];
  /** Códigos de erro, em ordem crescente. */
  errors: number[];
}

/** Tabela de status por operação (issue #5, caso 2). */
const STATUS_TABLE: Record<string, ExpectedStatuses> = {
  'POST /api/v1/search': { success: [200], errors: [400, 422, 429, 500, 502, 503] },
  'GET /api/v1/searches/{request_id}': { success: [200], errors: [404, 410, 500] },
  'GET /api/v1/categories': { success: [200], errors: [500, 503] },
  'GET /api/v1/skills': { success: [200], errors: [400, 422, 500] },
  'GET /api/v1/skills/{skill_id}': { success: [200], errors: [404, 500] },
  'POST /api/v1/admin/ingest': { success: [202], errors: [401, 409, 500] },
  // Numa listagem nao existe "ingestao em curso": o 409 e so do POST (§5.1).
  'GET /api/v1/admin/ingest/runs': { success: [200], errors: [401, 500] },
  'GET /healthz': { success: [200], errors: [500] },
  'GET /readyz': { success: [200], errors: [500, 503] },
  'GET /metrics': { success: [200], errors: [500] },
};

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

interface DocumentedOperation {
  path: string;
  method: HttpMethod;
  operation: OperationObject;
}

interface SchemaNode {
  /** Caminho de propriedades desde o schema raiz (inclui o nome do componente). */
  trail: string[];
  schema: SchemaObject;
}

/** Dublê do banco: gerar o documento não deve abrir socket para o Postgres. */
class PrismaStub {
  ping(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

function isReference(value: unknown): value is ReferenceObject {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { $ref?: unknown }).$ref === 'string'
  );
}

function resolvePointer(doc: OpenAPIObject, pointer: string): unknown {
  let node: unknown = doc;
  for (const raw of pointer.replace(/^#\//, '').split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (typeof node !== 'object' || node === null) {
      throw new Error(`$ref não resolvível no documento gerado: ${pointer}`);
    }
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/** Segue `$ref` até o objeto concreto; único lugar que conhece o formato `#/`. */
function deref<T>(doc: OpenAPIObject, value: unknown): T | undefined {
  let current = value;
  for (let hops = 0; hops < 16; hops += 1) {
    if (!isReference(current)) {
      return current as T | undefined;
    }
    current = resolvePointer(doc, current.$ref);
  }
  throw new Error('$ref circular no documento gerado');
}

/** Todos os `$ref` de um schema, descendo por `allOf`/`oneOf`/`anyOf`. */
function referenceNames(value: unknown): string[] {
  const pending: unknown[] = [value];
  const refs: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (isReference(current)) {
      refs.push(current.$ref);
      continue;
    }
    if (typeof current !== 'object' || current === null) {
      continue;
    }
    const schema = current as SchemaObject;
    pending.push(...(schema.allOf ?? []), ...(schema.oneOf ?? []), ...(schema.anyOf ?? []));
  }
  return refs;
}

/** Achata o schema em nós com o caminho de propriedades até cada um. */
function collectNodes(
  doc: OpenAPIObject,
  schema: unknown,
  trail: string[],
  nodes: SchemaNode[],
  ancestors: ReadonlySet<SchemaObject> = new Set(),
): void {
  const node = deref<SchemaObject>(doc, schema);
  if (node === undefined || ancestors.has(node)) {
    return;
  }

  const path = new Set(ancestors).add(node);
  for (const [name, child] of Object.entries(node.properties ?? {})) {
    const childNode = deref<SchemaObject>(doc, child);
    if (childNode === undefined || path.has(childNode)) {
      continue;
    }
    const childTrail = [...trail, name];
    nodes.push({ trail: childTrail, schema: childNode });
    collectNodes(doc, childNode, childTrail, nodes, path);
  }
  if (node.items !== undefined) {
    collectNodes(doc, node.items, trail, nodes, path);
  }
  for (const branch of [...(node.allOf ?? []), ...(node.oneOf ?? []), ...(node.anyOf ?? [])]) {
    collectNodes(doc, branch, trail, nodes, path);
  }
}

/** Nós de todos os componentes do documento. */
function componentNodes(doc: OpenAPIObject): SchemaNode[] {
  const nodes: SchemaNode[] = [];
  for (const [name, schema] of Object.entries(doc.components?.schemas ?? {})) {
    collectNodes(doc, schema, [name], nodes, new Set());
  }
  return nodes;
}

function propertiesOf(
  doc: OpenAPIObject,
  schema: SchemaObject | undefined,
  ancestors: ReadonlySet<SchemaObject> = new Set(),
): Record<string, SchemaObject> {
  const merged: Record<string, SchemaObject> = {};
  if (schema === undefined || ancestors.has(schema)) {
    return merged;
  }

  const path = new Set(ancestors).add(schema);
  for (const [name, child] of Object.entries(schema.properties ?? {})) {
    const resolved = deref<SchemaObject>(doc, child);
    if (resolved !== undefined) {
      merged[name] = resolved;
    }
  }
  for (const branch of schema.allOf ?? []) {
    Object.assign(merged, propertiesOf(doc, deref<SchemaObject>(doc, branch), path));
  }
  return merged;
}

function requiredOf(
  doc: OpenAPIObject,
  schema: SchemaObject | undefined,
  ancestors: ReadonlySet<SchemaObject> = new Set(),
): string[] {
  if (schema === undefined || ancestors.has(schema)) {
    return [];
  }

  const path = new Set(ancestors).add(schema);
  const required = [...(schema.required ?? [])];
  for (const branch of schema.allOf ?? []) {
    required.push(...requiredOf(doc, deref<SchemaObject>(doc, branch), path));
  }
  return required;
}

function componentSchema(doc: OpenAPIObject, name: string): SchemaObject {
  const schema = deref<SchemaObject>(doc, doc.components?.schemas?.[name]);
  if (schema === undefined) {
    throw new Error(`schema ausente no documento gerado: #/components/schemas/${name}`);
  }
  return schema;
}

function allOperations(doc: OpenAPIObject): DocumentedOperation[] {
  return Object.entries(doc.paths).flatMap(([path, item]) =>
    HTTP_METHODS.flatMap((method) => {
      const operation = item[method];
      return operation === undefined ? [] : [{ path, method, operation }];
    }),
  );
}

function findOperation(doc: OpenAPIObject, method: HttpMethod, path: string): OperationObject {
  const item: PathItemObject | undefined = doc.paths[path];
  const operation = item?.[method];
  if (operation === undefined) {
    throw new Error(`operação ausente no contrato v0: ${method.toUpperCase()} ${path}`);
  }
  return operation;
}

function queryParameters(
  doc: OpenAPIObject,
  operation: OperationObject,
): Map<string, ParameterObject> {
  const parameters = new Map<string, ParameterObject>();
  for (const raw of operation.parameters ?? []) {
    const parameter = deref<ParameterObject>(doc, raw);
    if (parameter !== undefined && parameter.in === 'query') {
      parameters.set(parameter.name, parameter);
    }
  }
  return parameters;
}

function parameterSchema(
  doc: OpenAPIObject,
  parameter: ParameterObject | undefined,
): SchemaObject | undefined {
  return deref<SchemaObject>(doc, parameter?.schema);
}

/** Extensões (`x-*`) não existem no tipo `OperationObject` do `@nestjs/swagger`. */
function extension(operation: OperationObject, name: string): unknown {
  return (operation as unknown as Record<string, unknown>)[name];
}

const FORBIDDEN_PROPERTIES: ReadonlyArray<RegExp> = [
  /^client_hash$/,
  /^cache_key$/,
  /^intent_hash$/,
  /^prompt_version$/,
  /^RANK_W/,
  /^IP_HASH_SALT$/,
  /^LLM_BASE_URL$/,
  /^raw$/,
  /^skill_md(?:_(?:full|content|text|body))?$/,
];

function isForbiddenProperty(name: string): boolean {
  return name === 'id' || FORBIDDEN_PROPERTIES.some((pattern) => pattern.test(name));
}

function responseSchema(
  doc: OpenAPIObject,
  operation: OperationObject,
  status: number,
): SchemaObject | undefined {
  const response = deref<ResponseObject>(doc, operation.responses[String(status)]);
  return deref<SchemaObject>(doc, response?.content?.['application/json']?.schema);
}

function readArtifact(): string {
  return readFileSync(OPENAPI_ARTIFACT, 'utf8');
}

describe('OpenAPI contract v0 (issue #5)', () => {
  let app: INestApplication | undefined;
  let doc: OpenAPIObject;

  beforeAll(async () => {
    // Grafo de contrato, não de runtime: o AppModule só monta /api/v1/* a partir da F2.4.
    const moduleRef = await Test.createTestingModule({ imports: [OpenApiDocumentModule] })
      .overrideProvider(PrismaService)
      .useValue(new PrismaStub())
      .compile();

    app = moduleRef.createNestApplication();
    applyGlobalPrefix(app);
    await app.init();
    doc = SwaggerModule.createDocument(app, openApiOptions());
  });

  afterAll(async () => {
    await app?.close();
  });

  it('documents the ten v0 paths', () => {
    const paths = Object.keys(doc.paths).sort();
    expect(paths).toEqual([...EXPECTED_PATHS]);

    // A distribuição não é uniforme: sete rotas sob `/api/v1` e três na raiz
    // (`PUBLIC_ROUTES` do `main.ts`). Um filtro só pelo prefixo acharia sete.
    expect(paths).toHaveLength(10);
    expect(paths.filter((path) => path.startsWith('/api/v1/'))).toHaveLength(7);

    const internal = allOperations(doc)
      .filter(({ operation }) => extension(operation, 'x-internal') === true)
      .map(({ method, path }) => `${method.toUpperCase()} ${path}`)
      .sort();
    expect(internal).toHaveLength(5);
    expect(internal).toEqual([
      'GET /api/v1/admin/ingest/runs',
      'GET /healthz',
      'GET /metrics',
      'GET /readyz',
      'POST /api/v1/admin/ingest',
    ]);

    const admin = [
      ['post', '/api/v1/admin/ingest'],
      ['get', '/api/v1/admin/ingest/runs'],
    ] as const;
    for (const [method, path] of admin) {
      const operation = findOperation(doc, method, path);
      expect({ path, internal: extension(operation, 'x-internal') }).toEqual({
        path,
        internal: true,
      });
      expect({ path, tags: operation.tags ?? [] }).toEqual({
        path,
        tags: expect.arrayContaining(['admin']),
      });
    }
  });

  it('every operation declares its error statuses and no catch-all', () => {
    const operations = allOperations(doc);
    expect(operations.map(({ method, path }) => `${method.toUpperCase()} ${path}`).sort()).toEqual(
      Object.keys(STATUS_TABLE).sort(),
    );

    for (const { method, path, operation } of operations) {
      const key = `${method.toUpperCase()} ${path}`;
      const expected = STATUS_TABLE[key];
      if (expected === undefined) {
        throw new Error(`operação fora da tabela de status do contrato v0: ${key}`);
      }

      expect({ key, hasDefault: 'default' in operation.responses }).toEqual({
        key,
        hasDefault: false,
      });

      const statuses = Object.keys(operation.responses);
      const numeric = statuses.map(Number).sort((left, right) => left - right);
      expect({
        key,
        nonNumeric: statuses.filter((status) => !Number.isInteger(Number(status))),
      }).toEqual({
        key,
        nonNumeric: [],
      });
      expect({ key, errors: numeric.filter((status) => status >= 400) }).toEqual({
        key,
        errors: expected.errors,
      });

      const success = numeric.filter((status) => status < 400);
      expect({ key, successCount: success.length }).toEqual({ key, successCount: 1 });
      expect({
        key,
        unexpectedSuccess: success.filter((status) => !expected.success.includes(status)),
      }).toEqual({
        key,
        unexpectedSuccess: [],
      });
    }

    // §5.5: `502 LLM_BAD_RESPONSE` só existe com `?strict_llm=true`, então o
    // parâmetro precisa estar documentado como booleano e opcional.
    const search = findOperation(doc, 'post', '/api/v1/search');
    const strictLlm = queryParameters(doc, search).get('strict_llm');
    expect(strictLlm).toBeDefined();
    expect(parameterSchema(doc, strictLlm)?.type).toBe('boolean');
    expect(strictLlm?.required).not.toBe(true);
  });

  it('error responses use the single envelope', () => {
    const responses = allOperations(doc).flatMap(({ method, path, operation }) =>
      Object.entries(operation.responses)
        .filter(([status]) => Number(status) >= 400)
        .map(([status, response]) => ({
          key: `${method.toUpperCase()} ${path} → ${status}`,
          json: deref<ResponseObject>(doc, response)?.content?.['application/json'],
        })),
    );
    expect(responses.length).toBeGreaterThan(0);

    const withoutEnvelope = responses
      .filter(
        ({ json }) =>
          json === undefined || !referenceNames(json.schema).includes(ERROR_ENVELOPE_REF),
      )
      .map(({ key }) => key);
    expect(withoutEnvelope).toEqual([]);

    const envelope = componentSchema(doc, 'ErrorEnvelope');
    expect(requiredOf(doc, envelope)).toEqual(expect.arrayContaining(['request_id', 'error']));

    const error = propertiesOf(doc, envelope).error;
    expect(error).toBeDefined();
    expect(requiredOf(doc, error)).toEqual(expect.arrayContaining(['code', 'message', 'details']));

    // `retry_after_seconds` distingue "agora não" (429) de ausência: inteiro nulo.
    const retryAfter = propertiesOf(doc, error).retry_after_seconds;
    expect(retryAfter).toBeDefined();
    expect(retryAfter?.type).toBe('integer');
    expect(retryAfter?.nullable).toBe(true);
  });

  it('error codes are upper snake and come from the catalog', () => {
    const payloads: unknown[] = [componentSchema(doc, 'ErrorEnvelope')];
    for (const { operation } of allOperations(doc)) {
      for (const [status, response] of Object.entries(operation.responses)) {
        if (Number(status) < 400) {
          continue;
        }
        const json = deref<ResponseObject>(doc, response)?.content?.['application/json'];
        if (json !== undefined) {
          payloads.push(json.schema);
        }
      }
    }

    const listed: unknown[] = [];
    for (const payload of payloads) {
      const nodes: SchemaNode[] = [];
      collectNodes(doc, payload, [], nodes, new Set());
      for (const { trail, schema } of nodes) {
        if (trail[trail.length - 1] === 'code' && schema.enum !== undefined) {
          listed.push(...schema.enum);
        }
      }
    }

    expect(listed.length).toBeGreaterThan(0);
    const catalog = new Set<string>(Object.values(ERROR_CODES));
    expect(
      listed.filter((code) => typeof code !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(code)),
    ).toEqual([]);
    expect(listed.filter((code) => typeof code === 'string' && !catalog.has(code))).toEqual([]);
  });

  it('absent data is null and never zero', () => {
    const nullableWhenAbsent = [
      'stars',
      'installs',
      'vulnerability_count',
      'summary',
      'repo_url',
      'skill_md_excerpt',
    ] as const;
    const nodes = componentNodes(doc);

    const report = nullableWhenAbsent.map((field) => {
      // `stars`/`installs`/`vulnerability_count` também aparecem em
      // `score_breakdown` como fator normalizado S/P/I: lá nunca são nulos.
      const hits = nodes.filter(
        (node) =>
          node.trail[node.trail.length - 1] === field &&
          !node.trail.some((step) => /score.?breakdown/i.test(step)),
      );
      return {
        field,
        present: hits.length > 0,
        notNullable: hits
          .filter((node) => node.schema.nullable !== true)
          .map((node) => node.trail.join('.')),
      };
    });

    expect(report.map(({ field, present }) => ({ field, present }))).toEqual(
      nullableWhenAbsent.map((field) => ({ field, present: true })),
    );
    expect(report.filter(({ notNullable }) => notNullable.length > 0)).toEqual([]);

    const breakdowns = nodes.filter((node) =>
      /^score.?breakdown$/i.test(node.trail[node.trail.length - 1] ?? ''),
    );
    expect(breakdowns.length).toBeGreaterThan(0);

    const factors = ['stars', 'vulnerabilities', 'installs'] as const;
    const factorReport = breakdowns.flatMap(({ trail, schema }) => {
      const properties = propertiesOf(doc, schema);
      return factors.map((factor) => ({
        at: trail.join('.'),
        factor,
        type: properties[factor]?.type,
        nullable: properties[factor]?.nullable === true,
      }));
    });
    expect(factorReport.filter(({ type, nullable }) => type !== 'number' || nullable)).toEqual([]);
  });

  it('search response carries the frozen shape', () => {
    const searchResponse = componentSchema(doc, 'SearchResponse');
    expect(requiredOf(doc, searchResponse)).toEqual(
      expect.arrayContaining([
        'request_id',
        'intent',
        'llm',
        'data',
        'results',
        'warnings',
        'recommendation',
      ]),
    );

    const data = propertiesOf(doc, searchResponse).data;
    expect(data).toBeDefined();
    expect(requiredOf(doc, data)).toEqual(
      expect.arrayContaining([
        'degraded',
        'degraded_reason',
        'catalog_snapshot',
        'age_seconds',
        'source',
      ]),
    );
    const dataProperties = propertiesOf(doc, data);
    expect(dataProperties.degraded?.type).toBe('boolean');
    // Decisão ratificada: `degraded_reason` é bi-valorado e nulo quando nada degrada.
    expect(dataProperties.degraded_reason?.nullable).toBe(true);
    expect([...(dataProperties.degraded_reason?.enum ?? [])].sort()).toEqual([
      'llm_unavailable',
      'source_stale',
    ]);

    const resultItem = componentSchema(doc, 'ResultItem');
    expect(requiredOf(doc, resultItem)).toEqual(
      expect.arrayContaining([
        'rank',
        'score',
        'score_breakdown',
        'evidence_completeness',
        'skill',
        'explanation',
        'flags',
        'caveats',
      ]),
    );
    // `caveats` é `string | null`: o motivo vai em texto livre, não em lista.
    const caveats = propertiesOf(doc, resultItem).caveats;
    expect(caveats?.type).toBe('string');
    expect(caveats?.nullable).toBe(true);

    expect(propertiesOf(doc, searchResponse).warnings?.type).toBe('array');

    const categories = responseSchema(doc, findOperation(doc, 'get', '/api/v1/categories'), 200);
    expect(categories).toBeDefined();
    expect(requiredOf(doc, categories)).toContain('data_snapshot');
    const snapshot = propertiesOf(doc, categories).data_snapshot;
    expect(snapshot?.type).toBe('string');
    expect(snapshot?.format).toBe('date-time');
  });

  it('llm status is the frozen seven-value enum', () => {
    const llm = propertiesOf(doc, componentSchema(doc, 'SearchResponse')).llm;
    expect(llm).toBeDefined();

    const llmProperties = propertiesOf(doc, llm);
    expect([...(llmProperties.status?.enum ?? [])]).toEqual([
      'ok',
      'cached',
      'repaired',
      'invalid_ids',
      'low_confidence',
      'unavailable',
      'disabled',
    ]);
    expect(llmProperties.cached?.type).toBe('boolean');
    expect(llmProperties.model?.nullable).toBe(true);
    expect(llmProperties.tokens?.nullable).toBe(true);
  });

  it('search request validates the documented bounds', () => {
    const body = deref<RequestBodyObject>(
      doc,
      findOperation(doc, 'post', '/api/v1/search').requestBody,
    );
    expect(body).toBeDefined();
    const bodySchema = deref<SchemaObject>(doc, body?.content?.['application/json']?.schema);
    expect(bodySchema).toBeDefined();

    const properties = propertiesOf(doc, bodySchema);
    const required = requiredOf(doc, bodySchema);
    expect(required).toContain('query');
    expect(properties.query?.minLength).toBe(3);
    expect(properties.query?.maxLength).toBe(500);
    expect(properties.limit?.minimum).toBe(1);
    expect(properties.limit?.maximum).toBe(20);
    expect(properties.limit?.default).toBe(5);

    // Cross-issue: o frontend desta milestone manda {category: null} quando nada
    // foi escolhido. Sem nullable o caminho padrao do cliente vira 422.
    expect(properties.category?.nullable).toBe(true);
    expect(properties.category?.minLength).toBe(1);
    expect(required).not.toContain('category');
  });

  it('skills list freezes sort and pagination', () => {
    const parameters = queryParameters(doc, findOperation(doc, 'get', '/api/v1/skills'));
    const sortBy = parameterSchema(doc, parameters.get('sort_by'));
    const page = parameterSchema(doc, parameters.get('page'));
    const pageSize = parameterSchema(doc, parameters.get('page_size'));

    expect([...(sortBy?.enum ?? [])]).toEqual(['installs', 'stars', 'name']);
    expect(sortBy?.default).toBe('installs');
    expect(page?.minimum).toBe(1);
    expect(pageSize?.minimum).toBe(1);
    expect(pageSize?.maximum).toBe(100);
    expect(pageSize?.default).toBe(20);
  });

  it('the versioned artifact equals the generated document', () => {
    expect(doc.info.version).toBe('0.1.0');
    // O `DocumentBuilder` devolve `servers: []`; o contrato proíbe declarar
    // servidor, porque o prefixo já viaja em cada path e `servers: /api/v1`
    // resolveria `/api/v1/api/v1/...` (§5 e `main.ts`).
    expect(doc.servers ?? []).toEqual([]);

    const artifact = parse(readArtifact()) as OpenAPIObject;
    expect(artifact).toEqual(doc);
  });

  it('the artifact leaks no credential', () => {
    const raw = readArtifact();
    // `apiKey` é o `type` do security scheme do header `X-Admin-Token` no OpenAPI,
    // não um segredo: o padrão exige o separador (`api_key`/`api-key`), que é a
    // forma de um vazamento de chave — nunca do nome do tipo.
    expect(raw).not.toMatch(
      /LLM_API_KEY|authorization|bearer|api[_-]key|client_hash|cache_key|intent_hash|prompt_version|RANK_W_|IP_HASH_SALT|LLM_BASE_URL/i,
    );

    // Nome de campo e a regressao real: detalhe interno vaza quando vira
    // propriedade do payload, mesmo que o valor nao apareca no texto.
    const artifact = parse(raw) as OpenAPIObject;
    const nodes = componentNodes(artifact);
    expect(nodes.length).toBeGreaterThan(0);

    const names = nodes.map((node) => node.trail[node.trail.length - 1] ?? '');
    expect(names).toEqual(expect.arrayContaining(['skill_md_excerpt', 'request_id', 'error']));

    const forbidden = nodes
      .filter((node) => isForbiddenProperty(node.trail[node.trail.length - 1] ?? ''))
      .map((node) => node.trail.join('.'));
    expect(forbidden).toEqual([]);
  });

  it('metrics is documented as text/plain outside the prefix', () => {
    const metrics = findOperation(doc, 'get', '/metrics');
    const ok = deref<ResponseObject>(doc, metrics.responses['200']);
    expect(ok?.content?.['text/plain']).toBeDefined();
    expect(ok?.content?.['application/json']).toBeUndefined();
    expect(doc.paths['/api/v1/metrics']).toBeUndefined();

    // `PUBLIC_ROUTES` do `main.ts` mantém os dois probes fora do prefixo versionado.
    expect(findOperation(doc, 'get', '/healthz')).toBeDefined();
    expect(findOperation(doc, 'get', '/readyz')).toBeDefined();
    expect(doc.paths['/api/v1/healthz']).toBeUndefined();
    expect(doc.paths['/api/v1/readyz']).toBeUndefined();
  });
});
