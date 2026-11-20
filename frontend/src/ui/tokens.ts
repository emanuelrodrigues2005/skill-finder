/**
 * Tokens de design — direção "desenho técnico".
 *
 * O produto é um **catálogo de capacidades cuja ordem é calculada**: a tela existe para mostrar
 * *por que* uma skill vem antes da outra, com as contas à vista (estrelas, instalações,
 * vulnerabilidades e o peso de cada uma). A interface imita uma folha de medição, não um painel
 * de vendas: papel claro, tinta escura, régua e marcas.
 *
 * **Hex literal, nunca uma variável CSS.** O teste de contraste (`src/test/a11y.test.tsx`) lê
 * `element.style.color` e calcula a razão WCAG sobre esse valor; com `var()` o navegador
 * devolveria o nome da variável e não haveria número. Toda cor de token é `#rrggbb`.
 *
 * As razões de cada par são verificadas por `scripts/dev/contraste.py` antes de virarem código:
 * 4,5:1 para texto, 3:1 para fronteira e foco (WCAG AA). Trocar um hex aqui é mudar o número
 * medido pelo teste — rode o script antes.
 *
 * Duas camadas, de propósito:
 * - `palette` — a rampa crua. É a origem; ninguém pinta com ela direto.
 * - `color` — a camada semântica: o que a interface **quer dizer**. Componente importa `color`.
 */

/** Rampa de cores. Nome descritivo; o valor é o único lugar onde o hex aparece. */
export const palette = {
  paper: "#f7f8f6",
  white: "#ffffff",
  ink: "#0e1a20",
  inkBody: "#20303a",
  inkSubtle: "#33454f",
  inkMuted: "#55666f",
  /** Fronteira de componente: o cinza mais claro que ainda cumpre 3:1 sobre o papel. */
  rule: "#7b8a91",
  /** Divisor de baixa ênfase: não precisa cumprir piso, não carrega estado. */
  hairline: "#dfe4e1",
  /** "Sinal" — o verde-petróleo da marca. Link, foco e a marca da régua. */
  signal: "#14625e",
  /** Fundo do trilho lateral e de blocos de apoio. */
  wash: "#eef1ee",
  rust: "#a33528",
  amberInk: "#6e4a06",
  amberPaper: "#fbf3df",
  amberRule: "#8a5a0b",
  amberFlag: "#7a4a08",
  greenInk: "#155e3b",
  greenPaper: "#ecf6ef",
  greenRule: "#1e6b45",
} as const;

/**
 * Cor com significado. O papel decide o par de contraste medido pelo teste.
 *
 * `bg`/`surface` existem para isso: o fundo da página é pintado no `body`, mas é contra ele que
 * todo texto e toda borda são medidos.
 */
export const color = {
  /** Papel da página. */
  bg: palette.paper,
  /** Superfície sobre o papel (cartão, caixa de trecho). */
  surface: palette.white,
  /** Tinta padrão: título, corpo de texto fora de cartão. */
  text: palette.ink,
  /** Texto corrido dentro do cartão (as razões de cada resultado). */
  textBody: palette.inkBody,
  /** Número denso, lido em coluna (o score). */
  textSubtle: palette.inkSubtle,
  /** Texto secundário: metadados, contadores, dicas. O mais claro que ainda lê. */
  textMuted: palette.inkMuted,
  /** Fronteira de cartão, divisor e caixa do estado vazio. */
  border: palette.rule,
  /** Divisor de baixa ênfase, sem estado associado. */
  hairline: palette.hairline,
  /** Fundo do trilho lateral. */
  wash: palette.wash,
  /** Cor de link e de destaque (borda da recomendação, marca da régua). */
  link: palette.signal,
  /** Texto em cima de `link`. */
  onLink: palette.white,
  /** Anel de foco (`:focus-visible`, 3 px). */
  focus: palette.signal,
  /** Fronteira de erro. */
  danger: palette.rust,
  /** Fronteira de aviso (faixa degradada, histórico expirado, limite de uso, selo parcial). */
  warn: palette.amberRule,
  /** Fundo de aviso. */
  warnSurface: palette.amberPaper,
  /** Texto de aviso sobre `warnSurface`. */
  warnText: palette.amberInk,
  /** Texto da linha de `flags` do resultado. */
  flagText: palette.amberFlag,
  /** Fronteira do selo de evidência completa. */
  success: palette.greenRule,
  /** Fundo do selo de evidência completa. */
  successSurface: palette.greenPaper,
  /** Texto sobre `successSurface`. */
  successText: palette.greenInk,
} as const;

/**
 * Tipografia.
 *
 * Sem webfont (decisão registrada: nenhuma dependência de fonte). A personalidade vem de três
 * escolhas que não custam download: **numerais tabulares** em tudo que é medida (os números são o
 * argumento da tela e precisam alinhar em coluna), um salto grande entre `display` e o corpo, e
 * `letter-spacing` negativo só no título — em texto pequeno ele prejudica a leitura.
 */
export const font = {
  family: {
    sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    /** Medidas, ids e o rótulo da régua. */
    mono: 'ui-monospace, "Cascadia Mono", "SFMono-Regular", Menlo, Consolas, monospace',
  },
  size: {
    /** Selo (pill) do cartão: 11 px. */
    caption: "0.6875rem",
    /** Detalhe do selo: 12 px. */
    meta: "0.75rem",
    /** Metadados do cartão e rodapé: 13 px. */
    small: "0.8125rem",
    /** Texto secundário corrente: 14 px. */
    compact: "0.875rem",
    /** Item de lista e linha de ação: 15 px. */
    body: "0.9375rem",
    /** Subtítulo, `<dl>` de detalhe: 17 px. */
    lead: "1.0625rem",
    /** Título de cartão: 20 px. */
    title: "1.25rem",
    /** Título de seção (h2 das telas): 24 px. */
    heading: "1.5rem",
    /** Título do app (h1): 34 px. */
    display: "2.125rem",
  },
  weight: {
    regular: 400,
    /** Ênfase: rótulo, título de cartão, nome da recomendação. */
    strong: 600,
    /** Só o `display`: contraste de peso contra o corpo. */
    black: 700,
  },
  /** `-0.02em` no título; `0` no resto. */
  tracking: {
    tight: "-0.02em",
    normal: "0",
  },
  /** Altura de linha por papel. Corpo de texto respira mais que rótulo. */
  leading: {
    tight: 1.15,
    snug: 1.35,
    body: 1.6,
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
  /** 48 px */
  xxxl: "3rem",
} as const;

/**
 * Raios. Deliberadamente **não** um valor só: o produto tem três níveis de superfície e o raio
 * ajuda a lê-los. `none` existe para a régua, que é uma medida e não uma caixa.
 */
export const radius = {
  none: 0,
  sm: 4,
  md: 10,
  pill: 999,
} as const;

/** Largura máxima da coluna de leitura, em px. Acima disso a linha passa de ~80 caracteres. */
export const measure = {
  page: 1080,
  text: 68 * 16,
} as const;

/** Largura do anel de foco, em px. O CSS global sai daqui. */
const FOCUS_RING_WIDTH = 3;

/**
 * Anel de foco: 3 px sólido, 2 px de afastamento. O CSS global (`App.tsx`) lê daqui — a suíte de
 * acessibilidade procura `outline: <n>px solid` no `:focus-visible` e exige `n >= 2`.
 */
export const focusRing = {
  width: FOCUS_RING_WIDTH,
  offset: 2,
  outline: `${FOCUS_RING_WIDTH}px solid ${palette.signal}`,
} as const;
