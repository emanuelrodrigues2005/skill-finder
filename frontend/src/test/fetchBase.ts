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
 * O `AbortSignal` do jsdom pertence a outro realm e o `undici` (o `fetch` do Node, que é quem
 * executa mesmo sob `jsdom`) recusa: `TypeError: RequestInit: Expected signal ("AbortSignal {}")
 * to be an instance of AbortSignal`. Como `src/api.ts` passa `AbortSignal.timeout(...)` em toda
 * chamada, **toda** tela que buscava dados caía no erro genérico.
 *
 * A sonda abaixo mede isso em vez de supor: `Request` recebe o mesmo converter de `RequestInit`
 * que o `fetch`, então a rejeição aparece na construção. Em ambiente `node` (que é onde
 * `src/api.test.ts` roda) a sonda aceita o sinal e nada é descartado.
 */
function realmSignalAccepted(): boolean {
  if (typeof Request === "undefined") return false;
  try {
    new Request("http://localhost/", { signal: new AbortController().signal });
    return true;
  } catch {
    return false;
  }
}

/**
 * Devolve `init` sem `signal`. Usado só quando o realm não é compatível: o sinal existe para
 * cancelar a requisição, e cancelamento não é o que os testes de tela medem — o caminho do
 * timeout continua coberto em `src/api.test.ts` (ambiente `node`, `fetch` espiado).
 */
function withoutSignal(init: RequestInit | undefined): RequestInit | undefined {
  if (init === undefined || init.signal === undefined || init.signal === null) return init;
  const next: RequestInit = { ...init };
  delete next.signal;
  return next;
}

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
  // Medido uma vez por arquivo de teste: a resposta não muda durante a execução.
  const signalsAccepted = realmSignalAccepted();

  const patched: FetchImplementation = (input, init) => {
    const target = typeof input === "string" && input.startsWith("/") ? new URL(input, origin).toString() : input;
    return previous(target, signalsAccepted ? init : withoutSignal(init));
  };

  globalThis.fetch = patched;
  return () => {
    globalThis.fetch = previous;
  };
}
