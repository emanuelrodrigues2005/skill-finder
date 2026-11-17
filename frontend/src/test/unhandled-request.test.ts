/**
 * Sentinela do `onUnhandledRequest: 'error'` (issue #29).
 *
 * É este teste que prova o AGENTS.md regra 5 ("nenhum teste abre socket"): uma requisição sem
 * handler precisa **falhar**, não só aparecer no console. Se o MSW regredir para "só loga", a
 * requisição vaza para a rede e este teste fica vermelho.
 */
import { describe, expect, it } from "vitest";

import { TEST_ORIGIN } from "./fetchBase";

describe("MSW unhandled requests", () => {
  it("fails a request that has no handler", async () => {
    const error = await fetch(`${TEST_ORIGIN}/api/v1/unhandled-sentinel`).catch((caught: unknown) => caught);

    // Medido nesta máquina (msw 2.15): a estratégia `error` **rejeita** a requisição — o MSW
    // loga o caminho sem handler e a chamada falha. A mensagem da rejeição não repete o
    // caminho, então a asserção mira a frase da estratégia; uma falha de rede qualquer
    // (`TypeError: fetch failed`) não casaria e o teste não passaria pelo motivo errado.
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/Cannot bypass a request/);
    expect(String(error)).toMatch(/onUnhandledRequest/);
  });
});
