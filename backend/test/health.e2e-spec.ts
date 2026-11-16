import type { INestApplication } from '@nestjs/common';
import { Controller, Get } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '@/app.module';
import { configureApp } from '@/main';
import { PrismaService } from '@/prisma/prisma.service';

/** Dublê do banco: os testes de borda não abrem socket para o Postgres. */
class PrismaStub {
  reachable = true;

  ping(): Promise<boolean> {
    return Promise.resolve(this.reachable);
  }
}

/** Só existe para haver um 500 de verdade atravessando o filtro de §5.5. */
@Controller('boom')
class BoomController {
  @Get()
  boom(): never {
    throw new Error(`database exploded with ${process.env.LLM_API_KEY ?? 'no-key'}`);
  }
}

const LEAKED_SECRET = 'sk-test-must-not-leak';

describe('health, readiness and metrics (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaStub;

  beforeAll(async () => {
    prisma = new PrismaStub();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [BoomController],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /healthz answers 200 without touching dependencies', async () => {
    const response = await request(app.getHttpServer()).get('/healthz').expect(200);

    expect(response.body.status).toBe('ok');
    expect(response.headers['x-request-id']).toMatch(/^req_[0-9A-Z]{26}$/);
  });

  it('sets the hardening headers on every response', async () => {
    const response = await request(app.getHttpServer()).get('/healthz').expect(200);

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('marks the two probes as non-cacheable', async () => {
    const healthz = await request(app.getHttpServer()).get('/healthz').expect(200);
    expect(healthz.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');

    prisma.reachable = true;
    const readyz = await request(app.getHttpServer()).get('/readyz').expect(200);
    expect(readyz.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
  });

  it('mounts none of the contract routes before F2.4 (D0)', async () => {
    // O contrato v0 documenta rotas que o runtime ainda nao serve: se um
    // controller de src/contract vazar para o AppModule, estes caminhos
    // respondem 500 (o handler contractOnly lanca) em vez de 404.
    const contractRoutes = [
      ['post', '/api/v1/search'],
      ['get', '/api/v1/searches/req_01JCV8Y6Q4'],
      ['get', '/api/v1/categories'],
      ['get', '/api/v1/skills'],
      ['get', '/api/v1/skills/sk_01JCV8Y6Q4'],
      ['post', '/api/v1/admin/ingest'],
      ['get', '/api/v1/admin/ingest/runs'],
    ] as const;

    for (const [method, path] of contractRoutes) {
      const response =
        method === 'post'
          ? await request(app.getHttpServer()).post(path).expect(404)
          : await request(app.getHttpServer()).get(path).expect(404);

      expect({ path, code: response.body.error.code }).toEqual({ path, code: 'NOT_FOUND' });
    }
  });

  it('keeps health endpoints outside the /api/v1 prefix', async () => {
    await request(app.getHttpServer()).get('/healthz').expect(200);

    const response = await request(app.getHttpServer()).get('/api/v1/healthz').expect(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });

  it('GET /readyz answers 200 when the database answers', async () => {
    prisma.reachable = true;

    const response = await request(app.getHttpServer()).get('/readyz').expect(200);
    expect(response.body.status).toBe('ok');
  });

  it('GET /readyz answers 503 NOT_READY with reason db_unavailable', async () => {
    prisma.reachable = false;

    const response = await request(app.getHttpServer()).get('/readyz').expect(503);

    expect(response.body.request_id).toMatch(/^req_/);
    expect(response.body.error.code).toBe('NOT_READY');
    expect(response.body.error.details.reason).toBe('db_unavailable');
    expect(response.body.error.message).toBeTruthy();
    expect(response.body.error.stack).toBeUndefined();
    expect(response.body.error).not.toHaveProperty('statusCode');
  });

  it('GET /metrics exposes the http metrics of §9.1 without measuring probes or itself', async () => {
    prisma.reachable = true;
    await request(app.getHttpServer()).get('/healthz').expect(200);
    await request(app.getHttpServer()).get('/readyz').expect(200);

    const response = await request(app.getHttpServer()).get('/metrics').expect(200);

    // A instrumentação está viva: `/readyz` (rota de aplicação) é medido.
    expect(response.text).toContain('http_requests_total');
    expect(response.text).toContain('http_request_duration_seconds');
    expect(response.text).toContain('route="/readyz"');
    expect(response.text).toContain('method="GET"');
    expect(response.text).toContain('status="200"');

    // O healthcheck do compose e o scrape do Prometheus rodam em loop: contá-los
    // fazia cada scrape inflar o próprio counter.
    expect(response.text).not.toContain('route="/healthz"');
    expect(response.text).not.toContain('route="/metrics"');
  });

  it('a 500 answers the §5.5 envelope with neither stack nor environment values', async () => {
    process.env.LLM_API_KEY = LEAKED_SECRET;

    const response = await request(app.getHttpServer()).get('/api/v1/boom').expect(500);

    expect(response.body.request_id).toMatch(/^req_/);
    expect(Object.keys(response.body).sort()).toEqual(['error', 'request_id']);
    expect(Object.keys(response.body.error).sort()).toEqual(['code', 'details', 'message']);
    expect(response.body.error.code).toBe('INTERNAL');
    expect(response.body.error.message).toBe('Internal server error.');
    expect(response.body.error.stack).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain(LEAKED_SECRET);
  });

  it('errors speak the §5.5 envelope, including request_id', async () => {
    const response = await request(app.getHttpServer()).get('/does-not-exist').expect(404);

    expect(response.body.request_id).toMatch(/^req_/);
    expect(Object.keys(response.body).sort()).toEqual(['error', 'request_id']);
    expect(Object.keys(response.body.error).sort()).toEqual(['code', 'details', 'message']);
  });
});
