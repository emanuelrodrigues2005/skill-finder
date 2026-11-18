/**
 * Issue #12 — a fiação do `CatalogModule` (`backend/src/catalog/catalog.module.ts`,
 * 0% de cobertura antes deste spec).
 *
 * O módulo é o *seam* que permite servir produção e teste sem `if` espalhado: a
 * fonte, o repositório e o cliente Prisma entram por `forRoot`, não pelo
 * ambiente. Um erro aqui não estoura onde se olha — ele injeta o repositório
 * errado, e a ingestão grava em outro lugar (ou falha no boot, que é o caso bom).
 *
 * Contratos fixados:
 *
 * - `CATALOG_ADAPTER` é `fixture` por padrão e aceita outro nome;
 * - fonte e repositório injetados são usados **como estão** (identidade, não
 *   cópia): é assim que o duplo de teste entra;
 * - `repository` vence `prisma` quando os dois são passados (o duplo manda);
 * - sem `prisma` e sem `repository`, o `forRoot` **lança** — melhor falhar no
 *   boot do que servir um catálogo que nunca é persistido;
 * - construir o módulo não abre socket e não toca o banco.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Test } from '@nestjs/testing';
import type { PrismaClient } from '@prisma/client';

import { CATALOG_ADAPTER, CATALOG_REPOSITORY, CATALOG_SOURCE, CatalogModule, type CatalogModuleOptions } from '@/catalog/catalog.module';
import type { CatalogRepository } from '@/catalog/catalog-repository';
import { PrismaCatalogRepository } from '@/catalog/prisma-catalog.repository';
import type { CatalogPage, SkillRecord, SkillSource } from '@/catalog/skill-source';

/** Fonte injetada: o módulo tem de devolver **esta** referência. */
function stubSource(): SkillSource & { calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    capabilities: { supports_categories: true, supports_documents: true },
    listCategories: () =>
      Promise.resolve([{ slug: 'backend', label_en: 'Backend', position: 1 }]),
    // O módulo só repassa a fonte: construir não deve chamar nem chaves nem páginas.
    fetchSkills: (): Promise<SkillRecord[]> => Promise.resolve([]),
    fetchCatalog: (page: number): Promise<CatalogPage> => {
      calls.push(page);
      return Promise.resolve({ items: [], page, has_more: false });
    },
    fetchDocument: () => Promise.resolve(null),
  };
}

/** Repositório injetado: nenhum método é chamado por construir o módulo. */
function stubRepository(): CatalogRepository & { marker: string } {
  const fail = (): Promise<never> => Promise.reject(new Error('nao deveria ser chamado'));
  return {
    marker: 'stub',
    failStaleRuns: fail,
    startRun: fail,
    finishRun: fail,
    countActiveSkills: fail,
    selectRotationKeys: fail,
    upsertSkills: fail,
    deactivateSkillsNotSeenSince: fail,
    deactivateSkillsStaleBefore: fail,
  };
}

async function build(options: CatalogModuleOptions = {}) {
  return Test.createTestingModule({ imports: [CatalogModule.forRoot(options)] }).compile();
}

describe('CatalogModule.forRoot — tokens e valores padrão', () => {
  it('defaults the adapter to fixture and exports the three tokens', async () => {
    const moduleRef = await build({ source: stubSource(), repository: stubRepository() });

    expect(moduleRef.get(CATALOG_ADAPTER)).toBe('fixture');
    for (const token of [CATALOG_ADAPTER, CATALOG_SOURCE, CATALOG_REPOSITORY]) {
      expect(moduleRef.get(token)).toBeDefined();
    }
  });

  it('keeps a custom adapter name', async () => {
    const moduleRef = await build({
      adapter: 'html',
      source: stubSource(),
      repository: stubRepository(),
    });

    expect(moduleRef.get(CATALOG_ADAPTER)).toBe('html');
  });

  it('builds the dynamic module for itself and exports what it provides', () => {
    const dynamic = CatalogModule.forRoot({ source: stubSource(), repository: stubRepository() });

    expect(dynamic.module).toBe(CatalogModule);
    expect(dynamic.exports).toEqual([CATALOG_ADAPTER, CATALOG_SOURCE, CATALOG_REPOSITORY]);
  });
});

describe('CatalogModule.forRoot — fonte', () => {
  it('uses the injected source as-is', async () => {
    const source = stubSource();
    const moduleRef = await build({ source, repository: stubRepository() });

    const injected = moduleRef.get<SkillSource>(CATALOG_SOURCE);
    expect(injected).toBe(source);

    // E é ela quem responde às chamadas do módulo.
    await injected.fetchCatalog(1);
    expect(source.calls).toEqual([1]);
  });

  it('falls back to the frozen fixture sample when no source is injected', async () => {
    const moduleRef = await build({ repository: stubRepository() });

    const source = moduleRef.get<SkillSource>(CATALOG_SOURCE);
    const page = await source.fetchCatalog(1);

    // A fixture congelada tem 25 skills e a fonte não publica categorias/documentos.
    expect(page.items).toHaveLength(25);
    expect(page.has_more).toBe(false);
    expect(source.capabilities).toEqual({ supports_categories: false, supports_documents: false });
    expect(await source.listCategories()).toEqual([]);
    expect(await source.fetchDocument('vercel-labs/skills/find-skills')).toBeNull();
  });

  it('reads the injected fixture path instead of the default one', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'catalog-module-'));
    const path = join(directory, 'one.json');
    writeFileSync(
      path,
      JSON.stringify([
        { url: 'https://skills.sh/acme/toolbox/only-one', name: 'only-one — acme/toolbox' },
      ]),
      'utf8',
    );

    try {
      const moduleRef = await build({ fixturePath: path, repository: stubRepository() });
      const page = await moduleRef.get<SkillSource>(CATALOG_SOURCE).fetchCatalog(1);

      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.source_key).toBe('acme/toolbox/only-one');
      expect(page.items[0]?.name).toBe('only-one');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('CatalogModule.forRoot — repositório', () => {
  it('uses the injected repository as-is', async () => {
    const repository = stubRepository();
    const moduleRef = await build({ source: stubSource(), repository });

    expect(moduleRef.get(CATALOG_REPOSITORY)).toBe(repository);
  });

  it('builds the Prisma repository when only `prisma` is given', async () => {
    const prisma = {} as unknown as PrismaClient;
    const moduleRef = await build({ source: stubSource(), prisma });

    expect(moduleRef.get(CATALOG_REPOSITORY)).toBeInstanceOf(PrismaCatalogRepository);
  });

  it('prefers the injected repository over `prisma` (the double wins)', async () => {
    const repository = stubRepository();
    const moduleRef = await build({
      source: stubSource(),
      repository,
      prisma: {} as unknown as PrismaClient,
    });

    expect(moduleRef.get(CATALOG_REPOSITORY)).toBe(repository);
  });

  it('refuses to boot without `prisma` and without `repository`', async () => {
    // Falhar no boot é melhor do que servir um catálogo que nunca é persistido.
    await expect(build({ source: stubSource() })).rejects.toThrow(
      /CatalogModule\.forRoot requer `prisma` ou `repository`/,
    );
    await expect(build()).rejects.toThrow(/requer `prisma` ou `repository`/);
  });
});
