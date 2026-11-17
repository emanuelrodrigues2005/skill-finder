/**
 * Shim de `fetch` para URL relativa — só para os testes (issue #29).
 *
 * `requestJson` (`src/api.ts`) chama `fetch("/api/v1/search")`, relativo de propósito: no
 * navegador o host é o da própria página e nenhuma origem entra no bundle (AGENTS.md, regra 4).
 * O `fetch` do Node — que é o que o Vitest usa mesmo com `jsdom`, porque o jsdom não implementa
 * `fetch` — recusa URL relativa com `TypeError: Failed to parse URL from /api/v1/search`.
 *
 * Aqui o caminho é resolvido contra a origem que o jsdom anuncia em `location.origin`
 * (`vitest.config.ts`, `environmentOptions.jsdom.url`). Assim a requisição chega ao MSW como
 * `http://localhost:5173/api/v1/...` e os handlers casam caminho **e** origem.
 */

/** Origem dos testes: a mesma do `vite dev` e a que o jsdom usa como `location.origin`. */
export const TEST_ORIGIN = "http://localhost:5173";

export type FetchImplementation = typeof globalThis.fetch;

/**
 * Envolve o `fetch` corrente para resolver caminho relativo contra `origin` e devolve a função
 * que restaura o `fetch` anterior.
 *
 * Precisa ser instalado **depois** de `server.listen()` do MSW: o `listen` troca o `fetch`
 * global pelo interceptado, e o shim tem de ficar por fora dele. Na ordem inversa o MSW cobre o
 * shim e a URL relativa volta a estourar (o sintoma já foi medido nesta máquina).
 *
 * Só `string` é resolvida: `new Request("/api/v1/...")` nem chega a ser construído pelo undici,
 * e o cliente desta aplicação sempre passa string.
 */
export function installFetchBase(origin: string = TEST_ORIGIN): () => void {
  const previous = globalThis.fetch;

  const patched: FetchImplementation = (input, init) => {
    const target = typeof input === "string" && input.startsWith("/") ? new URL(input, origin).toString() : input;
    return previous(target, init);
  };

  globalThis.fetch = patched;
  return () => {
    globalThis.fetch = previous;
  };
}
