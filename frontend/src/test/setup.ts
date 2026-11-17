import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll } from "vitest";

import { installFetchBase } from "./fetchBase";
import { server } from "./msw/server";

/** Restauração do shim, criada no `beforeAll` e usada no `afterAll`. */
let restoreFetch: (() => void) | null = null;

beforeAll(() => {
  // Ordem importa. `server.listen()` troca o `fetch` global pelo interceptado do MSW; o shim de
  // URL relativa (`fetchBase.ts`) é aplicado *por cima* dele. Invertendo, o MSW cobriria o shim
  // e `fetch("/api/v1/search")` voltaria a estourar `TypeError: Failed to parse URL`.
  //
  // `onUnhandledRequest: 'error'`: requisição sem handler **falha** em vez de vazar para a rede
  // (AGENTS.md, regra 5). A prova disso é `src/test/unhandled-request.test.ts`.
  server.listen({ onUnhandledRequest: "error" });
  restoreFetch = installFetchBase();
});

afterEach(() => {
  // Sem `globals`, o Testing Library não registra o auto-cleanup: ele é explícito aqui.
  cleanup();
  server.resetHandlers();
  // Rascunho da tela de busca e qualquer resto de estado não vazam para o próximo teste. O
  // `api.test.ts` roda em ambiente `node`, onde `sessionStorage` não existe.
  if (typeof sessionStorage !== "undefined") sessionStorage.clear();
});

afterAll(() => {
  restoreFetch?.();
  restoreFetch = null;
  server.close();
});
