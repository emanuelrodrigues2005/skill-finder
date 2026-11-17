/**
 * Issue #7 (F2.x) — ingestão idempotente do catálogo: normalização no adaptador.
 *
 * Contrato exigido do código de produção (`backend/src/catalog/normalise.ts`), ratificado pelo
 * `architect` e por `docs/app/amostras/README.md` ("Mapa campo → origem", decisão D3):
 *
 *   export function httpsUrlOrNull(value: unknown): string | null;
 *   export function normaliseSkill(raw: RawSkill): SkillRecord;
 *   export function normaliseDocument(raw: RawDocument): DocumentRecord;
 *
 *   // `raw` é o formato do site (mesmo snake_case da amostra congelada):
 *   interface RawSkill { url: string; name?: string | null; summary?: string | null;
 *                        installs?: number | null; stars?: number | null;
 *                        repository?: string | null; first_seen?: string | null;
 *                        vulnerabilities?: number | null }
 *   interface RawDocument { source_key: string; markdown: string }
 *
 * Regras ratificadas que este arquivo prova:
 * - `summary` truncado em **280**, `skill_md_excerpt` em **600**, sem reticências acrescentadas
 *   (o texto do site já traz a elipse quando trunca; a nossa é corte puro).
 * - `source_key` = 3 segmentos do **path** da URL, lowercase, sem query nem fragmento.
 * - `name` = texto antes do primeiro `—` (U+2014); se ficar vazio, último segmento do `source_key`.
 * - URL só `https://`: `http://`, `javascript:`, `data:` e `//host` viram `null`.
 * - Dado ausente é `null`, nunca `0`; `vulnerability_count` é **sempre** `null` (D3, a fonte não
 *   publica o número) e `repo_url` é **sempre** `null` (a fonte não dá a URL; não sintetizar).
 *
 * Valores esperados são literais da decisão (280, 600, `vercel-labs/skills/find-skills`), nunca
 * recalculados do jeito que o código recalcula.
 */
import {
  httpsUrlOrNull,
  normaliseDocument,
  normaliseSkill,
} from '@/catalog/normalise';

/** URL real da amostra congelada (`docs/app/amostras/skills-sample-2026-11-15.json`). */
const SAMPLE_URL = 'https://www.skills.sh/vercel-labs/skills/find-skills';
const SAMPLE_KEY = 'vercel-labs/skills/find-skills';
/** `name` como a página entrega: título antes do em dash. */
const SAMPLE_NAME = 'find-skills — vercel-labs/skills';

/** Lê o campo como texto e falha com mensagem útil quando o normalizador devolveu outra coisa. */
function text(value: string | null | undefined): string {
  if (typeof value !== 'string') {
    throw new Error(`esperava string, recebi ${JSON.stringify(value)}`);
  }
  return value;
}

describe('catalog normalise (docs/app/amostras/README.md, D3)', () => {
  describe('summary — truncado em 280, corte puro', () => {
    it('400 caracteres viram exatamente 280, sem reticências', () => {
      // 399 repetições + cauda distinta, para o corte ser observável no último caractere.
      const summary = `${'z'.repeat(399)}W`;
      expect(summary).toHaveLength(400);

      const record = normaliseSkill({ url: SAMPLE_URL, name: SAMPLE_NAME, summary });

      expect(text(record.summary)).toHaveLength(280);
      expect(record.summary).toBe('z'.repeat(280));
      expect(text(record.summary)).not.toContain('…');
      expect(text(record.summary)).not.toContain('...');
    });

    it('resumo de 280 e de 279 passam intactos', () => {
      const exact = 'a'.repeat(280);
      const just = 'b'.repeat(279);

      expect(normaliseSkill({ url: SAMPLE_URL, name: SAMPLE_NAME, summary: exact }).summary).toBe(exact);
      expect(normaliseSkill({ url: SAMPLE_URL, name: SAMPLE_NAME, summary: just }).summary).toBe(just);
    });

    it('resumo ausente é null, nunca string vazia', () => {
      expect(normaliseSkill({ url: SAMPLE_URL, name: SAMPLE_NAME }).summary).toBeNull();
      expect(normaliseSkill({ url: SAMPLE_URL, name: SAMPLE_NAME, summary: null }).summary).toBeNull();
    });
  });

  describe('skill_md_excerpt — truncado em 600, corte puro', () => {
    it('900 caracteres viram exatamente 600, sem reticências', () => {
      const markdown = `${'m'.repeat(899)}F`;
      expect(markdown).toHaveLength(900);

      const document = normaliseDocument({ source_key: SAMPLE_KEY, markdown });

      expect(text(document.skill_md_excerpt)).toHaveLength(600);
      expect(document.skill_md_excerpt).toBe('m'.repeat(600));
      expect(text(document.skill_md_excerpt)).not.toContain('…');
      expect(text(document.skill_md_excerpt)).not.toContain('...');
    });

    it('markdown de 600 passa intacto', () => {
      const markdown = 'c'.repeat(600);

      expect(normaliseDocument({ source_key: SAMPLE_KEY, markdown }).skill_md_excerpt).toBe(markdown);
    });
  });

  describe('httpsUrlOrNull — só https:// absoluto', () => {
    it.each([
      ['http://', 'http://www.skills.sh/vercel-labs/skills/find-skills'],
      ['javascript:', 'javascript:alert(1)'],
      ['data:', 'data:text/html,<b>x</b>'],
      ['protocolo relativo', '//evil/x'],
      ['esquema em maiúsculas', 'HTTPS://www.skills.sh/vercel-labs/skills/find-skills'],
      ['sem esquema', 'www.skills.sh/vercel-labs/skills/find-skills'],
      ['vazio', ''],
      ['só espaço', '   '],
    ])('rejeita %s', (_label, value) => {
      expect(httpsUrlOrNull(value)).toBeNull();
    });

    it('rejeita null e undefined', () => {
      expect(httpsUrlOrNull(null)).toBeNull();
      expect(httpsUrlOrNull(undefined)).toBeNull();
    });

    it('aceita https:// e devolve a URL inalterada', () => {
      expect(httpsUrlOrNull(SAMPLE_URL)).toBe(SAMPLE_URL);
      expect(httpsUrlOrNull('https://github.com/vercel-labs/skills')).toBe(
        'https://github.com/vercel-labs/skills',
      );
    });
  });

  describe('source_key — 3 segmentos do path, lowercase, sem query/fragmento', () => {
    it('URL com query, fragmento e maiúsculas dá a mesma chave da URL limpa', () => {
      const messy = normaliseSkill({
        url: 'https://www.skills.sh/Vercel-Labs/Skills/Find-Skills?ref=x#top',
        name: SAMPLE_NAME,
      });
      const clean = normaliseSkill({ url: SAMPLE_URL, name: SAMPLE_NAME });

      expect(messy.source_key).toBe(SAMPLE_KEY);
      expect(clean.source_key).toBe(SAMPLE_KEY);
      expect(messy.source_key).toBe(clean.source_key);
    });

    it('a query não vaza para a chave e a URL https é preservada em source_url', () => {
      const record = normaliseSkill({ url: `${SAMPLE_URL}?ref=x#top`, name: SAMPLE_NAME });

      expect(record.source_key).toBe(SAMPLE_KEY);
      expect(record.source_key).not.toContain('?');
      expect(record.source_key).not.toContain('#');
      expect(record.source_url).toBe(`${SAMPLE_URL}?ref=x#top`);
    });
  });

  describe('name — texto antes do primeiro em dash, com fallback para o slug', () => {
    it('título "find-skills — vercel-labs/skills" vira "find-skills"', () => {
      expect(normaliseSkill({ url: SAMPLE_URL, name: SAMPLE_NAME }).name).toBe('find-skills');
    });

    const EMPTY_NAMES: ReadonlyArray<[label: string, name: string | null]> = [
      ['vazio', ''],
      ['só espaço', '   '],
      ['só o sufixo', '— vercel-labs/skills'],
      ['null', null],
    ];

    it.each(EMPTY_NAMES)('nome %s cai no último segmento do source_key', (_label, name) => {
      const record = normaliseSkill({ url: SAMPLE_URL, name });

      expect(record.name).toBe('find-skills');
      expect(record.name).not.toContain('—');
    });
  });

  describe('dado ausente é null, nunca zero', () => {
    it('métricas ausentes viram null', () => {
      const record = normaliseSkill({ url: SAMPLE_URL, name: SAMPLE_NAME });

      expect(record.installs).toBeNull();
      expect(record.stars).toBeNull();
      expect(record.vulnerability_count).toBeNull();
      expect(record.repo_url).toBeNull();
    });

    it('métricas presentes são preservadas como número', () => {
      const record = normaliseSkill({
        url: SAMPLE_URL,
        name: SAMPLE_NAME,
        installs: 4400000,
        stars: 39400,
      });

      expect(record.installs).toBe(4400000);
      expect(record.stars).toBe(39400);
    });
  });

  describe('campos que a fonte não entrega (D3)', () => {
    it('vulnerability_count é sempre null, mesmo se a origem trouxer número', () => {
      const record = normaliseSkill({
        url: SAMPLE_URL,
        name: SAMPLE_NAME,
        vulnerabilities: 3,
      });

      expect(record.vulnerability_count).toBeNull();
    });

    it('repo_url é null mesmo com repository preenchido — não sintetizar URL', () => {
      const record = normaliseSkill({
        url: SAMPLE_URL,
        name: SAMPLE_NAME,
        repository: 'vercel-labs/skills',
      });

      expect(record.repo_url).toBeNull();
    });
  });
});
