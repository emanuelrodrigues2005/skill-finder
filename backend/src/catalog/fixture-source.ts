/**
 * Adaptador `fixture` (`docs/app/02-arquitetura.md` §7.2c): a amostra congelada
 * da descoberta, 25 skills reais de 2026-11-15, copiada byte a byte para
 * `backend/test/fixtures/catalog-sample.json` (o espelho de verificação só copia
 * `backend/`, então o teste não pode ler `docs/` em tempo de execução).
 *
 * É o modo de dev/CI (`SKILL_SOURCE_KIND=fixture`) e a rede de segurança da
 * demo: sem rede, sem socket, sem estado compartilhado entre execuções. Cada
 * `createFixtureSource()` relê o arquivo, e o caminho é **injetado** — nunca
 * `__dirname`, que aponta para `dist/` depois do build.
 *
 * A fixture já vem no formato do site e sai normalizada por `normaliseSkill`:
 * `name` sem o sufixo `— owner/repo`, `source_key` de 3 segmentos lowercase,
 * `source_url` sempre `https://`, `vulnerability_count` e `repo_url` sempre
 * `null`. A fonte não tem categorias nem `SKILL.md`: `listCategories()` devolve
 * `[]` e `fetchDocument()` devolve `null` — resposta honesta, com as
 * capabilities avisando de antemão.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { normaliseSkill, type RawSkill } from './normalise';
import type { CatalogPage, SkillSource, SkillSourceCapabilities } from './skill-source';

/** Caminho padrão, relativo ao diretório de trabalho do backend. */
export const DEFAULT_FIXTURE_PATH = join('test', 'fixtures', 'catalog-sample.json');

/** Opções do adaptador; `path` existe para o teste apontar outra amostra. */
export interface FixtureSourceOptions {
  readonly path?: string;
}

const CAPABILITIES: SkillSourceCapabilities = {
  supports_categories: false,
  supports_documents: false,
};

const FIRST_PAGE = 1;

/** Cria um adaptador independente sobre a fixture congelada. */
export function createFixtureSource(options: FixtureSourceOptions = {}): SkillSource {
  const path = options.path ?? join(process.cwd(), DEFAULT_FIXTURE_PATH);
  let cached: readonly RawSkill[] | null = null;

  function rawSkills(): readonly RawSkill[] {
    // Leitura preguiçosa e memoizada por instância: criar a fonte não toca o disco.
    if (cached === null) {
      cached = readFixture(path);
    }
    return cached;
  }

  return {
    capabilities: CAPABILITIES,
    listCategories: () => Promise.resolve([]),
    fetchCatalog: (page: number): Promise<CatalogPage> => {
      if (page !== FIRST_PAGE) {
        return Promise.resolve({ items: [], page, has_more: false });
      }
      const items = rawSkills().map(normaliseSkill);
      return Promise.resolve({ items, page, has_more: false });
    },
    fetchDocument: () => Promise.resolve(null),
  };
}

/** Lê o JSON da amostra e mantém apenas as entradas que têm URL. */
function readFixture(path: string): readonly RawSkill[] {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed)) {
    throw new TypeError(`fixture do catálogo não é uma lista: ${path}`);
  }
  const skills: RawSkill[] = [];
  for (const entry of parsed as unknown[]) {
    const raw = toRawSkill(entry);
    if (raw !== null) {
      skills.push(raw);
    }
  }
  return skills;
}

function toRawSkill(value: unknown): RawSkill | null {
  if (!isRecord(value)) {
    return null;
  }
  const url = readText(value, 'url');
  if (url === null) {
    return null;
  }
  return {
    url,
    name: readText(value, 'name'),
    summary: readText(value, 'summary'),
    installs: readNumber(value, 'installs'),
    stars: readNumber(value, 'stars'),
    repository: readText(value, 'repository'),
    first_seen: readText(value, 'first_seen'),
    vulnerabilities: readNumber(value, 'vulnerabilities'),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readText(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
