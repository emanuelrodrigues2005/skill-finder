/**
 * Issue #7 — ingestão idempotente do catálogo: parser da página de detalhe.
 *
 * Contrato exigido do código de produção (`backend/src/catalog/html-parser.ts`):
 *
 *   export interface ParsedDetail {
 *     installs: number | null;     // "4.4M" -> 4400000, "1,234" -> 1234, ilegível -> null
 *     stars: number | null;
 *     repository: string | null;   // "owner/repo", como o site escreve
 *     first_seen: string | null;   // texto cru ("Jan 26, 2026"), não Date
 *   }
 *   export function parseDetailHtml(html: string): ParsedDetail;
 *
 * A decisão D3 (`docs/app/amostras/README.md`) fixou que `Installs`, `GitHub Stars`, `Repository` e
 * `First Seen` só existem como texto renderizado no DOM. O markup dos casos abaixo reproduz a
 * forma real da página (`docs/app/amostras/skill-detalhe.html`): rótulo num `<div>` com `<span>`,
 * valor no `<div>` irmão seguinte. O parser é tolerante a mudança de layout: rótulo ausente não
 * lança, devolve `null` — porque o modo de falha previsto em §7.2 é "seletor muda → métrica null",
 * nunca uma exceção que derruba a ingestão inteira.
 */
import { parseDetailHtml } from '@/catalog/html-parser';

/** Rótulo + valor no formato da página real (D3): `<div><span>Rótulo</span></div><div><span>valor</span></div>`. */
function metricBlock(label: string, value: string): string {
  return (
    '<div class="bg-background py-8">' +
    `<div class="text-sm font-mono uppercase text-white mb-2"><span>${label}</span></div>` +
    `<div class="flex items-center gap-1.5 text-sm font-mono text-foreground"><span>${value}</span></div>` +
    '</div>'
  );
}

interface DetailValues {
  installs?: string;
  stars?: string;
  repository?: string;
  firstSeen?: string;
}

function detailPage(values: DetailValues): string {
  const blocks: string[] = [];
  if (values.installs !== undefined) blocks.push(metricBlock('Installs', values.installs));
  if (values.stars !== undefined) blocks.push(metricBlock('GitHub Stars', values.stars));
  if (values.repository !== undefined) blocks.push(metricBlock('Repository', values.repository));
  if (values.firstSeen !== undefined) blocks.push(metricBlock('First Seen', values.firstSeen));

  return (
    '<!doctype html><html lang="en"><head>' +
    '<meta name="description" content="Helps users discover and install agent skills.">' +
    '<title>find-skills — vercel-labs/skills</title></head>' +
    `<body><main>${blocks.join('')}</main></body></html>`
  );
}

describe('catalog parser — página de detalhe (D3)', () => {
  it('extrai installs, stars, repository e first_seen da página completa', () => {
    const parsed = parseDetailHtml(
      detailPage({
        installs: '4.4M',
        stars: '205.9K',
        repository: 'vercel-labs/skills',
        firstSeen: 'Jan 26, 2026',
      }),
    );

    expect(parsed.installs).toBe(4400000);
    expect(parsed.stars).toBe(205900);
    expect(parsed.repository).toBe('vercel-labs/skills');
    expect(parsed.first_seen).toBe('Jan 26, 2026');
  });

  const COUNT_CASES: ReadonlyArray<[label: string, raw: string, expected: number | null]> = [
    ['sufixo M', '4.4M', 4400000],
    ['sufixo K', '205.9K', 205900],
    ['inteiro', '121', 121],
    ['separador de milhar', '1,234', 1234],
    ['ilegível', 'abc', null],
    ['zero de verdade não é ausência', '0', 0],
  ];

  it.each(COUNT_CASES)('converte instalações abreviadas: %s', (_label, raw, expected) => {
    expect(parseDetailHtml(detailPage({ installs: raw })).installs).toBe(expected);
  });

  it('converte estrelas abreviadas', () => {
    expect(parseDetailHtml(detailPage({ stars: '205.9K' })).stars).toBe(205900);
    expect(parseDetailHtml(detailPage({ stars: '39400' })).stars).toBe(39400);
  });

  /**
   * O rótulo é o **último** texto da página: existe a palavra, não existe valor
   * depois dela. O parser não pode devolver a linha vazia seguinte como se fosse
   * o valor — ausência é `null` (§7.2: seletor quebrado vira métrica `null`).
   */
  it('rótulo sem nenhuma linha depois dele é ausência, não string vazia', () => {
    const parsed = parseDetailHtml('<html><body><div><span>Installs</span></div></body></html>');

    expect(parsed.installs).toBeNull();
  });

  /**
   * `9` repetido 400 vezes passa na forma `[0-9]+` mas não é representável: o
   * `Number` vira `Infinity`. Métrica infinita não é dado do site — é valor
   * ilegível, e a coluna recebe `null` (nunca `Infinity`, que o Postgres nem tem).
   */
  it.each([['infinito por tamanho', '9'.repeat(400)]])(
    'conta não finita (%s) é ausência, não Infinity',
    (_label, raw) => {
      expect(parseDetailHtml(detailPage({ installs: raw })).installs).toBeNull();
    },
  );

  it('HTML sem nenhum dos rótulos devolve null em tudo, sem lançar', () => {
    const parsed = parseDetailHtml('<html><body><p>Skills</p><p>Nada de métricas aqui.</p></body></html>');

    expect(parsed.installs).toBeNull();
    expect(parsed.stars).toBeNull();
    expect(parsed.repository).toBeNull();
    expect(parsed.first_seen).toBeNull();
  });

  it('HTML vazio devolve null em tudo, sem lançar', () => {
    expect(() => parseDetailHtml('')).not.toThrow();

    const parsed = parseDetailHtml('');
    expect(parsed.installs).toBeNull();
    expect(parsed.stars).toBeNull();
    expect(parsed.repository).toBeNull();
    expect(parsed.first_seen).toBeNull();
  });

  /**
   * Entidade nomeada que o parser não conhece fica **literal**: o valor é dado da
   * fonte e o parser não inventa caractere. O que ele garante é que uma entidade
   * estranha não derruba a página nem apaga o resto do valor.
   */
  it('entidade nomeada desconhecida fica literal no valor', () => {
    const parsed = parseDetailHtml(
      '<div><span>Repository</span></div><div>owner/repo&naoexiste;</div>',
    );

    expect(parsed.repository).toBe('owner/repo&naoexiste;');
  });
});
