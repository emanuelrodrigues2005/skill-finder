/**
 * Issue #12 — `SKILL.md` -> texto puro (`backend/src/search/skill-md.ts`, 38,5%
 * de cobertura antes deste spec).
 *
 * O contrato de `GET /api/v1/skills/{skill_id}` promete `skill_md_excerpt` com
 * **no máximo 600 caracteres e sem markdown cru** (§5.4), e a interface renderiza
 * o valor escapado — nunca como HTML. Daí o que este spec fixa:
 *
 * - a limpeza remove a marcação (cercas, títulos, ênfase, links, imagens, tags,
 *   pipes de tabela) em vez de tentar renderizá-la;
 * - o **corte acontece depois da limpeza**: medir antes deixaria um trecho cheio
 *   de `#`/`[]()` que não cabe no teto;
 * - o corte é em fronteira de palavra quando existe uma, e exato quando não.
 *
 * Texto externo continua dado não confiável (regra 2): nada aqui interpreta o
 * conteúdo, só o reduz a prosa.
 */
import {
  MAX_EXCERPT_CHARS,
  MAX_SUMMARY_CHARS,
  plainSummary,
  skillMdExcerpt,
  toPlainText,
} from '@/search/skill-md';

describe('toPlainText — remoção de marcação', () => {
  it('strips headings and keeps the line structure', () => {
    expect(toPlainText('# Title\n\nBody text')).toBe('Title\nBody text');
    expect(toPlainText('### Deep\n###### Deeper')).toBe('Deep\nDeeper');
  });

  it('strips blockquote markers', () => {
    expect(toPlainText('> quoted line\n> second')).toBe('quoted line\nsecond');
  });

  it('strips list markers, ordered and unordered', () => {
    expect(toPlainText('- item one\n* item two\n+ item three\n1. item four')).toBe(
      'item one\nitem two\nitem three\nitem four',
    );
  });

  it('unwraps emphasis and inline code', () => {
    expect(toPlainText('**bold** and __also bold__ and _italic_ and *star*')).toBe(
      'bold and also bold and italic and star',
    );
    expect(toPlainText('run `pnpm test` now')).toBe('run pnpm test now');
  });

  it('unwraps links and drops images', () => {
    expect(toPlainText('read [the docs](https://example.test/docs) now')).toBe(
      'read the docs now',
    );
    expect(toPlainText('see ![alt text](https://example.test/a.png) here')).toBe('see here');
  });

  it('drops fenced code blocks entirely, both fence styles', () => {
    // Um trecho cortado no meio de um `docker run` não ajuda ninguém.
    const backticks = toPlainText('Intro\n```bash\ndocker run --rm thing\n```\nOutro');
    expect(backticks).toContain('Intro');
    expect(backticks).toContain('Outro');
    expect(backticks).not.toContain('docker');
    expect(backticks).not.toContain('```');

    const tildes = toPlainText('Intro\n~~~js\nconsole.log(1)\n~~~\nOutro');
    expect(tildes).not.toContain('console');
    expect(tildes).not.toContain('~~~');
  });

  it('drops HTML tags and turns table pipes into spaces', () => {
    expect(toPlainText('a <b>bold</b> c')).toBe('a bold c');

    const table = toPlainText('| name | stars |\n| --- | --- |\n| x | 1 |');
    expect(table).not.toContain('|');
    expect(table).toContain('name stars');
    expect(table).toContain('x 1');
  });

  it('normalizes CRLF and lone CR to LF', () => {
    expect(toPlainText('a\r\nb')).toBe('a\nb');
    expect(toPlainText('a\rb')).toBe('a\nb');
    expect(toPlainText('a\r\nb')).not.toContain('\r');
  });

  it('collapses runs of spaces, tabs and blank lines', () => {
    expect(toPlainText('a    b\t\tc')).toBe('a b c');
    expect(toPlainText('a\n\n\n\nb')).toBe('a\nb');
    expect(toPlainText('  \n  x  \n  ')).toBe('x');
  });

  it('answers an empty string for an empty document', () => {
    expect(toPlainText('')).toBe('');
    expect(toPlainText('   \n\t\n ')).toBe('');
  });
});

describe('skillMdExcerpt — teto de 600 depois da limpeza', () => {
  it('keeps a short document untouched', () => {
    expect(skillMdExcerpt('Finds skills for the current task.')).toBe(
      'Finds skills for the current task.',
    );
  });

  it('never returns more than 600 characters and never splits a word', () => {
    const excerpt = skillMdExcerpt('word '.repeat(200));

    expect(MAX_EXCERPT_CHARS).toBe(600);
    expect(excerpt.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
    expect(excerpt.length).toBeGreaterThan(0);
    // Nada de `wor` no fim: o corte é em fronteira de palavra.
    expect(excerpt.split(' ').every((part) => part === 'word')).toBe(true);
    expect(excerpt.endsWith('word')).toBe(true);
  });

  it('cuts exactly at the ceiling when the text has no whitespace', () => {
    const excerpt = skillMdExcerpt('x'.repeat(1000));

    // Sem espaço antes do teto não há fronteira de palavra: o corte é bruto.
    expect(excerpt).toHaveLength(MAX_EXCERPT_CHARS);
  });

  it('measures after cleaning, not before', () => {
    // 200 × "**a** " = 1200 caracteres crus; limpo dá "a a a ..." (399).
    const excerpt = skillMdExcerpt('**a** '.repeat(200));

    expect(excerpt).not.toContain('*');
    expect(excerpt).toHaveLength(399);
    expect(excerpt.length).toBeLessThan(MAX_EXCERPT_CHARS);
  });

  it('accepts an explicit ceiling', () => {
    expect(skillMdExcerpt('hello world foo', 8)).toBe('hello');
    expect(skillMdExcerpt('hello world foo', 100)).toBe('hello world foo');
  });
});

describe('plainSummary — teto de 280', () => {
  it('truncates at 280 by default and at the given ceiling', () => {
    expect(MAX_SUMMARY_CHARS).toBe(280);
    expect(plainSummary('b'.repeat(300))).toHaveLength(MAX_SUMMARY_CHARS);
    expect(plainSummary('b'.repeat(300), 10)).toHaveLength(10);
  });

  it('removes markup before measuring', () => {
    expect(plainSummary('**Finds** `skills` for the task')).toBe('Finds skills for the task');
  });

  it('cuts at a word boundary and trims the trailing space', () => {
    expect(plainSummary('hello world foo', 8)).toBe('hello');
    expect(plainSummary('hello world foo', 12)).toBe('hello world');
  });

  it('answers an empty string for empty input', () => {
    expect(plainSummary('')).toBe('');
  });
});
