import { http, HttpResponse } from "msw";

import type { ErrorEnvelope } from "../../types";
import { TEST_ORIGIN } from "../fetchBase";
import { categoriesFixture, errorEnvelope, REQUEST_ID, searchResponse, skillDetailFixture } from "../fixtures/search";

/**
 * Handlers do MSW derivados do contrato v0 (`openapi.yaml` › `paths./api/v1/...`).
 *
 * Os caminhos são absolutos, montados a partir de `TEST_ORIGIN`: em `jsdom` a URL relativa
 * resolveria contra `document.baseURI`, mas o teste do cliente roda em ambiente `node`, sem
 * `location`. Absoluto funciona nos dois.
 */

/** Origem dos handlers — a mesma que o shim de `fetch` usa para resolver o caminho relativo. */
export const API_ORIGIN = TEST_ORIGIN;

/** URL absoluta de uma rota de `/api/v1`, para `server.use(...)` no teste. */
export function apiUrl(path: string): string {
  return `${API_ORIGIN}/api/v1${path}`;
}

/** Resposta de erro no formato do contrato, com o status HTTP do caso (422, 429, 503, …). */
export function errorResponse(status: number, envelope: ErrorEnvelope): Response {
  return HttpResponse.json(envelope, { status });
}

export const handlers = [
  // `POST /api/v1/search` — sucesso canônico. Cada teste que precisa de falha faz `server.use`.
  http.post(apiUrl("/search"), () => HttpResponse.json(searchResponse)),

  // `GET /api/v1/searches/{request_id}` — só responde ao `request_id`. Um cliente que mandasse
  // o `search_id` interno receberia 404, e é isso que faz o teste do permalink morder.
  http.get(apiUrl("/searches/:requestId"), ({ params }) => {
    const requestId = String(params.requestId);
    if (requestId !== REQUEST_ID) {
      return errorResponse(404, errorEnvelope("NOT_FOUND", { requestId }));
    }
    return HttpResponse.json(searchResponse);
  }),

  // `GET /api/v1/categories` — alimenta o `<select>` da tela de busca.
  http.get(apiUrl("/categories"), () => HttpResponse.json(categoriesFixture)),

  // `GET /api/v1/skills/{skill_id}` — o detalhe; o 404 tem teste próprio com `server.use`.
  http.get(apiUrl("/skills/:skillId"), () => HttpResponse.json(skillDetailFixture)),
];
