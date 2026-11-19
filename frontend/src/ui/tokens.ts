/**
 * Tokens de design (issue #50, milestone F2.10).
 *
 * **Hex literal, nunca uma variável CSS.** O teste de contraste (`src/test/a11y.test.tsx`) lê
 * `element.style.color` e calcula a razão WCAG sobre esse valor; se o componente devolvesse uma
 * variável, o navegador entregaria o nome dela e não haveria número para calcular. Cor de token é
 * `#rrggbb`, com nome semântico.
 *
 * Duas camadas, de propósito:
 *
 * - `palette` — a rampa crua: o valor como ele existe hoje na tela. Ninguém importa `palette`
 *   para pintar; ela é a origem.
 * - `color` — a camada semântica: o que a interface **quer dizer** (`link`, `danger`, `warn`).
 *   Componente importa `color`. Trocar a paleta é mexer em `palette`; trocar o significado de
 *   uma cor é mexer aqui.
 *
 * `space` segue a escala de 4–32 px. Valor fora da escala (ajuste herdado de 2–4 px, como
 * `0.35rem`) continua literal no componente: encaixá-lo mudaria pixels.
 *
 * Os pisos do WCAG AA são medidos **sobre estes valores** em `src/test/a11y.test.tsx`: 4,5:1 para
 * par de texto e 3:1 para fronteira de componente/estado (o anel de foco, a borda das faixas de
 * erro e aviso, os selos). Mudar um hex aqui é mudar a razão medida ali — o teste diz o número.
 */

/** Rampa de cores. Nomes `hue + shade`; o valor é o único lugar onde o hex aparece. */
export const palette = {
  white: "#ffffff",
  slate900: "#0f172a",
  slate800: "#1e293b",
  slate700: "#334155",
  slate600: "#475569",
  blue700: "#1d4ed8",
  /**
   * Os três tons `450`/`650` não são degraus de uma escala pronta: são a mistura mínima que
   * cumpre o piso de 3:1 de fronteira (WCAG 1.4.11) sobre o fundo em que a cor é desenhada.
   * Escurecer além do necessário seria repintar a tela sem motivo — o piso é 3:1, não "o mais
   * escuro possível".
   */
  gray450: "#8f9298",
  red450: "#de6565",
  amber50: "#fffbeb",
  amber650: "#bd7a09",
  amber700: "#b45309",
  amber800: "#92400e",
  green600: "#16a34a",
  green50: "#f0fdf4",
  green800: "#166534",
} as const;

/**
 * Cor com significado. Cada token aqui tem um papel — e o papel decide o par de contraste que o
 * teste mede. `bg`/`surface` existem para isso: o fundo da página é o branco padrão do navegador,
 * ninguém o pinta, mas é contra ele que todo texto e toda borda são medidos.
 */
export const color = {
  /** Papel da página. */
  bg: palette.white,
  /** Superfície sobre o papel (cartão, caixa de trecho). Hoje igual ao papel. */
  surface: palette.white,
  /** Tinta padrão: título, corpo de texto fora de cartão. */
  text: palette.slate900,
  /** Texto corrido dentro do cartão (as razões de cada resultado). */
  textBody: palette.slate800,
  /** Número denso, lido em coluna (o score). */
  textSubtle: palette.slate700,
  /** Texto secundário: metadados, contadores, dicas. O mais claro que ainda lê. */
  textMuted: palette.slate600,
  /** Fronteira de cartão, divisor e caixa do estado vazio. */
  border: palette.gray450,
  /** Cor de link e de destaque (borda da recomendação, selo). */
  link: palette.blue700,
  /** Texto em cima de `link`. */
  onLink: palette.white,
  /** Anel de foco (`:focus-visible`, 3 px). */
  focus: palette.blue700,
  /** Fronteira de erro. */
  danger: palette.red450,
  /** Fronteira de aviso (faixa degradada, histórico expirado, limite de uso, selo parcial). */
  warn: palette.amber650,
  /** Fundo de aviso. */
  warnSurface: palette.amber50,
  /** Texto de aviso sobre `warnSurface`. */
  warnText: palette.amber800,
  /** Texto da linha de `flags` do resultado. */
  flagText: palette.amber700,
  /** Fronteira do selo de evidência completa. */
  success: palette.green600,
  /** Fundo do selo de evidência completa. */
  successSurface: palette.green50,
  /** Texto sobre `successSurface`. */
  successText: palette.green800,
} as const;

/**
 * Tipografia. Os tamanhos são os que as telas usam hoje, nomeados pelo papel — não por uma
 * escala abstrata: mudar `heading` move todo título de seção.
 */
export const font = {
  family: {
    sans: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
    mono: "monospace",
  },
  size: {
    /** Selo (pill) do cartão: 11.2 px. */
    caption: "0.7rem",
    /** Detalhe do selo: 12 px. */
    meta: "0.75rem",
    /** Metadados do cartão e rodapé: 12.8 px. */
    small: "0.8rem",
    /** Texto secundário corrente (o mais usado): 13.6 px. */
    compact: "0.85rem",
    /** Item de lista e linha de ação: 14.4 px. */
    body: "0.9rem",
    /** Subtítulo, `<dl>` de detalhe: 15.2 px. */
    lead: "0.95rem",
    /** Título de cartão: 16 px. */
    title: "1rem",
    /** Título de seção (h2 das telas): 17.6 px. */
    heading: "1.1rem",
    /** Título do app (h1): 22.4 px. */
    display: "1.4rem",
  },
  weight: {
    /** Ênfase: rótulo, título de cartão, nome da recomendação. */
    strong: 600,
  },
} as const;

/** Escala de espaçamento em `rem` (o comentário traz o px equivalente a 16 px de raiz). */
export const space = {
  /** 4 px */
  xs: "0.25rem",
  /** 8 px */
  sm: "0.5rem",
  /** 12 px */
  md: "0.75rem",
  /** 16 px */
  lg: "1rem",
  /** 24 px */
  xl: "1.5rem",
  /** 32 px */
  xxl: "2rem",
} as const;

/** Raios: `md` para caixa e cartão, `pill` para selo. */
export const radius = {
  md: 8,
  pill: 999,
} as const;

/** Largura do anel de foco, em px. A issue #50 pede 3 — e o CSS global sai daqui. */
const FOCUS_RING_WIDTH = 3;

/**
 * Anel de foco: 3 px sólido, 2 px de afastamento. O CSS global (`App.tsx`) lê daqui — a suíte
 * de acessibilidade procura `outline: <n>px solid` no `:focus-visible` e exige `n >= 2`.
 */
export const focusRing = {
  width: FOCUS_RING_WIDTH,
  offset: 2,
  outline: `${FOCUS_RING_WIDTH}px solid ${palette.blue700}`,
} as const;
