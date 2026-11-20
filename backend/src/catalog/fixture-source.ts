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
 *
 * `fetchSkills(keys)` (#44) é o caminho do rodízio: normaliza a amostra uma vez
 * num índice `source_key -> SkillRecord` e responde só o que foi pedido. Chave
 * desconhecida é omitida e não vira exceção (contrato em `skill-source.ts`).
 * `listKeys()` (#46) devolve as 25 chaves da amostra — é o bootstrap do catálogo
 * vazio. Não há listagem paginada: a aquisição é sempre por chave.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { normaliseSkill, type RawSkill } from './normalise';
import type { SkillRecord, SkillSource, SkillSourceCapabilities } from './skill-source';

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

/** Cria um adaptador independente sobre a fixture congelada. */
export function createFixtureSource(options: FixtureSourceOptions = {}): SkillSource {
  const path = options.path ?? join(process.cwd(), DEFAULT_FIXTURE_PATH);
  let cached: readonly RawSkill[] | null = null;
  let index: ReadonlyMap<string, SkillRecord> | null = null;

  function rawSkills(): readonly RawSkill[] {
    // Leitura preguiçosa e memoizada por instância: criar a fonte não toca o disco.
    if (cached === null) {
      cached = readFixture(path);
    }
    return cached;
  }

  function skillsByKey(): ReadonlyMap<string, SkillRecord> {
    // A normalização custa a amostra inteira; o rodízio pede várias chaves por
    // ciclo, então o índice é construído na primeira chamada e reusado.
    if (index === null) {
      index = new Map(
        rawSkills().map((raw) => {
          const record = normaliseSkill(raw);
          return [record.source_key, record] as const;
        }),
      );
    }
    return index;
  }

  return {
    capabilities: CAPABILITIES,
    listCategories: () => Promise.resolve([]),
    fetchSkills: async (keys: readonly string[]): Promise<SkillRecord[]> => {
      // Sem chaves pedidas, a fixture nem é lida: resposta vazia não é erro.
      if (keys.length === 0) {
        return Promise.resolve([]);
      }
      const known = skillsByKey();
      const asked = new Set<string>();
      const records: SkillRecord[] = [];
      for (const key of keys) {
        if (asked.has(key)) {
          continue;
        }
        asked.add(key);
        const record = known.get(key);
        if (record !== undefined) {
          // Chave desconhecida simplesmente não entra: ausência, não exceção.
          records.push(record);
        }
      }
      return Promise.resolve(records);
    },
    // Enumeração das chaves da amostra: o bootstrap do catálogo vazio. A
    // normalização não é feita aqui — quem busca o detalhe é `fetchSkills(keys)`.
    listKeys: (): Promise<string[]> => Promise.resolve([...skillsByKey().keys()]),
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
