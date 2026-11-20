/**
 * Tokens de design (issue #50, milestone F2.10).
 *
 * O contrato que este arquivo prova é o de baixo nível: **a paleta é a única fonte de cor**. Se
 * um componente volta a escrever `#1d4ed8` à mão, o teste acusa o arquivo e o valor — o
 * revisor não precisa procurar hex no diff.
 *
 * O contraste (WCAG AA) não está aqui: ele lê os mesmos tokens e vive em `a11y.test.tsx`, junto
 * do resto do que se prova sobre o que a tela entrega.
 */
import { describe, expect, it } from "vitest";

import { color } from "../ui/tokens";

/**
 * O Vite transforma este glob em imports `?raw`: cada fonte do app entra como texto, sem
 * `node:fs` (o projeto não tem `@types/node` e não precisa ter por causa disto).
 *
 * A declaração abaixo cobre só a parte da API do Vite que o teste usa. O projeto não carrega
 * `vite/client` (não há `vite-env.d.ts`); se um dia carregar, o `typecheck` avisa que esta
 * declaração virou redundante.
 */
declare global {
  interface ImportMeta {
    glob(
      patterns: string[],
      options: { query: string; import: string; eager: true },
    ): Record<string, string>;
  }
}

/**
 * Fontes do app, já em texto. Fora do escopo: o próprio `ui/tokens.ts` (é a fonte) e tudo que é
 * teste (`src/test/**`, `*.test.ts(x)`) — teste pode escrever hex para provar o cálculo.
 */
const SOURCES = import.meta.glob(
  [
    "../**/*.{ts,tsx}",
    "!../**/*.test.{ts,tsx}",
    "!../**/*.test-d.ts",
    "!../test/**",
    "!../ui/tokens.ts",
  ],
  { query: "?raw", import: "default", eager: true },
);

/** `#rgb` a `#rrggbbaa` — a mesma forma que o `grep` do critério de aceitação procura. */
const LOOSE_HEX = /#[0-9a-fA-F]{3,8}/g;

/** Cor de token: hex de 6 dígitos, minúsculo. `var(--token)` não passa aqui. */
const TOKEN_HEX = /^#[0-9a-f]{6}$/;

describe("the palette is the only source of colour", () => {
  it("reads the app sources, so a broken glob cannot pass silently", () => {
    const paths = Object.keys(SOURCES);
    expect(paths).toContain("../App.tsx");
    expect(paths).toContain("../pages/ResultsPage.tsx");
    expect(paths).toContain("../components/States.tsx");
  });

  it("leaves no loose hex outside ui/tokens.ts", () => {
    const offenders = Object.entries(SOURCES).flatMap(([path, source]) => {
      const found = source.match(LOOSE_HEX) ?? [];
      return found.length === 0 ? [] : [`${path}: ${found.join(", ")}`];
    });

    // Lista vazia = toda cor vem de `ui/tokens.ts`. Quando falha, a mensagem diz o arquivo e
    // os valores que faltam migrar.
    expect(offenders).toEqual([]);
  });
});

describe("token shape", () => {
  it("declares every colour as a six-digit hex literal, never var()", () => {
    // `var()` não serviria: o teste de contraste lê `element.style.color`, e o navegador
    // devolveria a string da variável em vez do valor.
    for (const [name, value] of Object.entries(color)) {
      expect(value, `color.${name}`).toMatch(TOKEN_HEX);
    }
  });
});
