/**
 * Tela de resultados (issue #29) — seis casos.
 *
 * A tela recebe a resposta por dois caminhos: `location.state` (a busca recém-feita) e o
 * permalink `/results?search=<request_id>` (aba nova, URL colada). Os dois são exercitados aqui.
 */
import { cleanup, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import ResultsPage from "../../pages/ResultsPage";
import type { SearchResponse } from "../../types";
import {
  degradedSearchResponse,
  emptySearchResponse,
  errorEnvelope,
  nullFieldsSearchResponse,
  REQUEST_ID,
  searchResponse,
} from "../fixtures/search";
import { currentLocation, renderRoutes, type InitialEntry, type RouteSpec } from "../harness";
import { apiUrl, errorResponse } from "../msw/handlers";
import { server } from "../msw/server";

const ROUTES: RouteSpec[] = [
  { path: "/results", element: <ResultsPage /> },
  { path: "/", element: <p>search screen</p> },
];

/** `request_id` de um replay que falhou — o suporte precisa dele na tela. */
const FAILED_REQUEST_ID = "req_failed_500";

const permalinkPath = `/results?search=${REQUEST_ID}`;

function serveReplay(body: SearchResponse): void {
  server.use(http.get(apiUrl(`/searches/${REQUEST_ID}`), () => HttpResponse.json(body)));
}

function renderResults(entry: InitialEntry = permalinkPath): void {
  renderRoutes(ROUTES, entry);
}

describe("ResultsPage", () => {
  it("shows the empty state when the response has no results", async () => {
    serveReplay(emptySearchResponse);

    renderResults();

    expect(await screen.findByText(/no skills matched — try broader wording/)).toBeVisible();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("renders the degraded banner with the reason and the snapshot age", async () => {
    serveReplay(degradedSearchResponse);

    renderResults();

    expect(await screen.findByText("The catalog snapshot is stale")).toBeVisible();
    expect(screen.getByText(/degraded_reason/)).toHaveTextContent(/source_stale/);
    expect(screen.getByText(/2\.0 h old \(7200 s\)/)).toBeVisible();
    // Lista vazia com explicação: a regra 7 proíbe vazio sem motivo.
    expect(screen.getByText(/the answer is degraded/)).toBeVisible();
  });

  it("renders null catalog fields as n/a instead of zero", async () => {
    serveReplay(nullFieldsSearchResponse);

    renderResults();

    expect(
      await screen.findByText(/category n\/a · stars n\/a · installs n\/a · vulns n\/a/),
    ).toBeVisible();
    expect(screen.getByText(/3 missing fields · confidence ×0\.82/)).toBeVisible();
    // O `score` existe no contrato e continua numérico: `n/a` é só para o que veio `null`.
    expect(screen.getByText("score 0.5100")).toBeVisible();
  });

  it("loads the permalink with exactly one GET and never repeats the search POST", async () => {
    let gets = 0;
    let posts = 0;
    server.use(
      http.get(apiUrl(`/searches/${REQUEST_ID}`), () => {
        gets += 1;
        return HttpResponse.json(searchResponse);
      }),
      http.post(apiUrl("/search"), () => {
        posts += 1;
        return HttpResponse.json(searchResponse);
      }),
    );

    // 1) Permalink puro (aba nova, URL colada): um `GET`, nenhum `POST`.
    renderResults();
    expect(await screen.findByRole("heading", { name: "Results" })).toBeVisible();
    // O permalink é endereçado pelo `request_id` visível, nunca pelo `search_id` interno.
    expect(screen.getByLabelText("permalink")).toHaveValue(`http://localhost:5173${permalinkPath}`);
    expect(currentLocation()).toBe(permalinkPath);
    expect(gets).toBe(1);
    expect(posts).toBe(0);

    cleanup();
    gets = 0;

    // 2) Chegando da busca (`location.state` + `?search=`): o state pinta a tela e o servidor
    // revalida com **um** `GET` — a busca não é refeita, então segue zero `POST`.
    renderResults({ pathname: "/results", search: `?search=${REQUEST_ID}`, state: { response: searchResponse } });
    expect(await screen.findByRole("heading", { name: "Results" })).toBeVisible();
    expect(gets).toBe(1);
    expect(posts).toBe(0);

    cleanup();
    gets = 0;

    // 3) Sem `?search=` não há permalink a revalidar: o state é a única fonte, zero chamada.
    renderResults({ pathname: "/results", state: { response: searchResponse } });
    expect(await screen.findByRole("heading", { name: "Results" })).toBeVisible();
    expect(gets).toBe(0);
    expect(posts).toBe(0);
  });

  it("shows the rate-limit message with the retry delay in seconds", async () => {
    server.use(
      http.get(apiUrl(`/searches/${REQUEST_ID}`), () =>
        errorResponse(429, errorEnvelope("RATE_LIMITED", { retryAfterSeconds: 30 })),
      ),
    );

    renderResults();

    expect(await screen.findByText("Too many requests. Try again in 30 seconds.")).toBeVisible();
    expect(screen.getByText("RATE_LIMITED")).toBeVisible();
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
    expect(screen.queryByText(/server said:/)).toBeNull();
  });

  it("keeps the request id of a replay that failed", async () => {
    server.use(
      http.get(apiUrl(`/searches/${REQUEST_ID}`), () =>
        errorResponse(500, errorEnvelope("INTERNAL", { requestId: FAILED_REQUEST_ID })),
      ),
    );

    renderResults();

    expect(await screen.findByText("Something went wrong on our side. Try again.")).toBeVisible();
    expect(screen.getByLabelText("request_id")).toHaveValue(FAILED_REQUEST_ID);
  });
});
