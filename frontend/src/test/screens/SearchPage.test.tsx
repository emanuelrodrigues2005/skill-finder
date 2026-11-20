/**
 * Tela de busca (issue #29) — seis casos.
 *
 * Nenhum teste abre socket: as requisições passam pelo MSW (`src/test/setup.ts`,
 * `onUnhandledRequest: 'error'`) e o caminho relativo do cliente é resolvido contra
 * `TEST_ORIGIN` pelo shim de `src/test/fetchBase.ts`.
 */
import { fireEvent, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import SearchPage from "../../pages/SearchPage";
import { errorEnvelope, REQUEST_ID, SEARCH_ID, searchResponse } from "../fixtures/search";
import { currentLocation, renderRoutes, type RouteSpec } from "../harness";
import { apiUrl, errorResponse } from "../msw/handlers";
import { server } from "../msw/server";

const ROUTES: RouteSpec[] = [
  { path: "/", element: <SearchPage /> },
  { path: "/results", element: <p>results screen</p> },
];

function renderSearch(): void {
  renderRoutes(ROUTES, "/");
}

function queryBox(): HTMLElement {
  return screen.getByLabelText(/o que você precisa que a skill faça/i);
}

function submitButton(): HTMLElement {
  return screen.getByRole("button", { name: /^buscar$/i });
}

/** Submete pelo `form`: a navegação do `MemoryRouter` não depende de implementação de browser. */
function submit(): void {
  const form = submitButton().closest("form");
  if (form === null) throw new Error("search form not found");
  fireEvent.submit(form);
}

function typeQuery(value: string): void {
  fireEvent.change(queryBox(), { target: { value } });
}

describe("SearchPage", () => {
  it("does not call the API when the query has two characters", async () => {
    let searchCalls = 0;
    server.use(
      http.post(apiUrl("/search"), () => {
        searchCalls += 1;
        return HttpResponse.json(searchResponse);
      }),
    );

    renderSearch();
    typeQuery("ab");

    expect(submitButton()).toBeDisabled();
    // Mesmo com o submit forçado, o handler desiste antes da chamada.
    submit();
    expect(searchCalls).toBe(0);
    expect(currentLocation()).toBe("/");
  });

  it("shows the unknown-category message with the request id and does not navigate", async () => {
    server.use(
      http.post(
        apiUrl("/search"),
        () =>
          errorResponse(
            422,
            errorEnvelope("VALIDATION_ERROR", {
              details: { reason: "UNKNOWN_CATEGORY", fields: ["category"] },
            }),
          ),
      ),
    );

    renderSearch();
    typeQuery("extract tables from a pdf");
    submit();

    // A mensagem é a do mapa de código, não a do servidor: `server said:` não pode aparecer.
    expect(await screen.findByText("Essa categoria não existe. Escolha uma da lista.")).toBeVisible();
    expect(screen.queryByText(/server said:/)).toBeNull();
    expect(screen.getByLabelText("request_id")).toHaveValue(REQUEST_ID);
    expect(currentLocation()).toBe("/");
  });

  it("shows the source-unavailable message and stays on the search page", async () => {
    server.use(http.post(apiUrl("/search"), () => errorResponse(503, errorEnvelope("SOURCE_UNAVAILABLE"))));

    renderSearch();
    typeQuery("extract tables from a pdf");
    submit();

    expect(
      await screen.findByText("Fonte de dados indisponível — tente de novo mais tarde."),
    ).toBeVisible();
    expect(screen.queryByText(/server said:/)).toBeNull();
    expect(currentLocation()).toBe("/");
  });

  it("navigates with the request id, never with the internal search id", async () => {
    server.use(http.post(apiUrl("/search"), () => HttpResponse.json(searchResponse)));

    renderSearch();
    typeQuery("extract tables from a pdf");
    submit();

    await screen.findByText("results screen");
    expect(currentLocation()).toBe(`/results?search=${REQUEST_ID}`);
    expect(currentLocation()).not.toContain(SEARCH_ID);
  });

  it("restores the draft from sessionStorage on mount", async () => {
    sessionStorage.setItem(
      "skills-search:draft:v1",
      JSON.stringify({ query: "summarise a changelog", category: "documents" }),
    );

    renderSearch();

    expect(queryBox()).toHaveValue("summarise a changelog");
    // A categoria só aparece no `<select>` depois do `GET /categories`: o valor restaurado
    // ganha a opção correspondente quando a lista chega. O rótulo da opção é o `label_en` do
    // catálogo — dado de terceiro, mostrado como publicado, nunca traduzido.
    await expect(screen.findByRole("option", { name: "Documents" })).resolves.toBeInTheDocument();
    expect(screen.getByLabelText(/categoria \(opcional\)/i)).toHaveValue("documents");
  });

  it("counts the trimmed query in the character counter", () => {
    renderSearch();
    typeQuery("  ab  ");

    expect(screen.getByText(/2\/500 caracteres/)).toBeVisible();
    expect(submitButton()).toBeDisabled();
  });
});
