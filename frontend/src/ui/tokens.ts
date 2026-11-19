/**
 * Tokens de design (issue #50, milestone F2.10).
 *
 * **Hex literal, nunca `var(--token)`.** O teste de contraste (`src/test/a11y.test.tsx`) lê
 * `element.style.color` e calcula a razão WCAG sobre esse valor; se o componente devolvesse
 * `var(--color-link)`, o navegador entregaria a string da variável e não haveria número para
 * calcular. Cor de token é `#rrggbb`, com nome semântico.
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
 * `0.35rem`) continua literal no componente: encaixá-lo mudaria pixels, e a extração dos tokens
 * não muda nenhum pixel — quem muda valor é o commit da paleta.
 */

/** Rampa de cores. Nomes `hue + shade`; o valor é o único lugar onde o hex aparece. */
export const palette = {
  white: "#ffffff",
  slate900: "#0f172a",
  slate800: "#1e293b",
  slate700: "#334155",
  slate600: "#475569",
  slate300: "#cbd5e1",
  slate200: "#e2e8f0",
  blue700: "#1d4ed8",
  red400: "#f87171",
  amber200: "#fbbf24",
  amber500: "#f59e0b",
  amber50: "#fffbeb",
  amber800: "#92400e",
  amber700: "#b45309",
  green600: "#16a34a",
  green50: "#f0fdf4",
  green800: "#166534",
} as const;

/**
 * Cor com significado. Cada token aqui é usado por pelo menos uma tela; a cor que não tem
 * significado próprio fica na `palette` até ter.
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
  /** Fronteira de cartão e divisor. */
  border: palette.slate200,
  /** Fronteira do estado vazio (tracejada). */
  borderDashed: palette.slate300,
  /** Cor de link e de destaque (borda da recomendação, selo). */
  link: palette.blue700,
  /** Texto em cima de `link`. */
  onLink: palette.white,
  /** Anel de foco (`:focus-visible`, 3 px). */
  focus: palette.blue700,
  /** Fronteira de erro. */
  danger: palette.red400,
  /** Fronteira de aviso (faixa degradada, histórico expirado, limite de uso). */
  warn: palette.amber200,
  /** Fronteira do selo de evidência parcial. */
  warnAccent: palette.amber500,
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

/**
 * Anel de foco: 3 px sólido, 2 px de afastamento. O CSS global (`App.tsx`) lê daqui — a suíte
 * de acessibilidade procura `outline: <n>px solid` no `:focus-visible` e exige `n >= 2`.
 */
export const focusRing = {
  width: 3,
  offset: 2,
  outline: `3px solid ${palette.blue700}`,
} as const;
