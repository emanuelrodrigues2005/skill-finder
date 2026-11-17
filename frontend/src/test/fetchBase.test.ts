/**
 * O shim de `fetch` da suíte (issue #28). Ele é o único ponto que sabe da fronteira jsdom ↔ Node:
 * caminho relativo (o cliente usa `/api/v1/...`) e `RequestInit` que o `undici` aceita.
 *
 * O segundo caso é uma regressão medida: o `AbortSignal` do jsdom pertence a outro realm e o
 * `undici` o rejeita com `TypeError: RequestInit: Expected signal ("AbortSignal {}") to be an
 * instance of AbortSignal`. Como `src/api.ts` passa `AbortSignal.timeout(...)` em toda chamada,
 * sem esta normalização **toda** tela que busca dados cai no erro genérico.
 */
import { describe, expect, it } from "vitest";

import { TEST_ORIGIN } from "./fetchBase";
import { apiUrl } from "./msw/handlers";

describe("fetch shim", () => {
  it("resolves a relative path against the test origin and reaches the handler", async () => {
    const response = await fetch(apiUrl("/categories").replace(TEST_ORIGIN, ""));

    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty("data");
  });

  it("still reaches the handler when the caller passes AbortSignal.timeout", async () => {
    const response = await fetch("/api/v1/categories", { signal: AbortSignal.timeout(15_000) });

    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty("data");
  });

  it("leaves an absolute url untouched", async () => {
    const response = await fetch(`${TEST_ORIGIN}/api/v1/categories`);

    expect(response.status).toBe(200);
  });
});
