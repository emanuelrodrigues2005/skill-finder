/**
 * Estados por tela (issue #28 — "loading/empty/error/success presentes em Search, Results e
 * Detail") e as duas partes do AC que exigem comportamento, não atributo: o 429 que **mantém** o
 * resultado anterior e o estado vazio com as três ações acionáveis.
 *
 * Os testes da #29 cobrem o caminho de erro das três telas; aqui ficam os estados que ainda não
 * tinham prova: carregando, vazio da busca, e as ações do vazio.
 */
import { fireEvent, screen, within } from "@testing-library/react";
import { delay, http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import DetailPage from "../../pages/DetailPage";
import ResultsPage from "../../pages/ResultsPage";
import SearchPage from "../../pages/SearchPage";
import type { SearchResponse } from "../../types";
import {
  categoriesFixture,
  emptySearchResponse,
  errorEnvelope,
  REQUEST_ID,
  searchResponse,
} from "../fixtures/search";
import { currentLocation, renderRoutes, type InitialEntry, type RouteSpec } from "../harness";
import { apiUrl, errorResponse } from "../msw/handlers";
import { server } from "../msw/server";

const DRAFT_KEY = "skills-search:draft:v1";
const PERMALINK = `/results?search=${REQUEST_ID}`;

const ROUTES: RouteSpec[] = [
  { path: "/", element: <SearchPage /> },
  { path: "/results", element: <ResultsPage /> },
  { path: "/skills/:id", element: <DetailPage /> },
];

function renderAt(entry: InitialEntry): void {
  renderRoutes(ROUTES, entry);
}

/** Replay do permalink que devolve a resposta pedida. */
function serveReplay(body: SearchResponse): void {
  server.use(http.get(apiUrl(`/searches/${REQUEST_ID}`), () => HttpResponse.json(body)));
}

/** Resposta que só chega depois do primeiro render — é o que deixa o estado "carregando" visível. */
function serveReplaySlowly(): void {
  server.use(
    http.get(apiUrl(`/searches/${REQUEST_ID}`), async () => {
      await delay(20);
      return HttpResponse.json(searchResponse);
    }),
  );
}

describe("estados por tela", () => {
  it("Search: shows the loading state while the categories are on their way", async () => {
    server.use(
      http.get(apiUrl("/categories"), async () => {
        await delay(20);
        return HttpResponse.json(categoriesFixture);
      }),
    );

    renderAt("/");

    expect(screen.getByText("Loading categories…")).toBeVisible();
    // O select chega depois; esperar o fim evita deixar requisição pendente para o próximo teste.
    await expect(screen.findByRole("option", { name: "Documents" })).resolves.toBeInTheDocument();
    expect(screen.queryByText("Loading categories…")).toBeNull();
  });

  it("Search: shows the empty state when the catalog has no categories", async () => {
    server.use(
      http.get(apiUrl("/categories"), () => HttpResponse.json({ ...categoriesFixture, data: [] })),
    );

    renderAt("/");

    expect(
      await screen.findByText("no categories available — you can still search without one"),
    ).toBeVisible();
  });

  it("Results: shows the loading state while the replay is on its way", async () => {
    serveReplaySlowly();

    renderAt(PERMALINK);

    expect(screen.getByText("Searching…")).toBeVisible();
    await expect(screen.findByRole("heading", { name: "Results" })).resolves.toBeVisible();
  });

  it("Detail: shows the loading state while the skill is on its way", async () => {
    server.use(
      http.get(apiUrl("/skills/:skillId"), async () => {
        await delay(20);
        return HttpResponse.json({
          request_id: REQUEST_ID,
          data: {
            skill_id: "skl_pdf_extract",
            name: "pdf-extract",
            summary: "Extracts text and tables from PDF documents.",
            source_url: null,
            repo_url: null,
            category: null,
            stars: null,
            installs: null,
            vulnerability_count: null,
            security_status: "unknown",
            skill_md_present: false,
            skill_md_excerpt: null,
          },
        });
      }),
    );

    renderAt("/skills/skl_pdf_extract");

    expect(screen.getByText("Loading skill…")).toBeVisible();
    await expect(screen.findByRole("heading", { name: "pdf-extract" })).resolves.toBeVisible();
  });

  it("Results: a 429 keeps the previous result on screen and only adds the warning", async () => {
    server.use(
      http.get(apiUrl(`/searches/${REQUEST_ID}`), () =>
        errorResponse(429, errorEnvelope("RATE_LIMITED", { retryAfterSeconds: 30 })),
      ),
    );

    // A busca recém-feita pinta a lista e o replay do permalink bate no limite de uso.
    renderAt({ pathname: "/results", search: `?search=${REQUEST_ID}`, state: { response: searchResponse } });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Too many searches. Try again in 30 seconds.");
    expect(alert).toHaveTextContent("RATE_LIMITED");
    // O resultado anterior continua na tela — o 429 não troca a lista por uma tela de erro.
    expect(screen.getByText("1. pdf-extract")).toBeVisible();
    expect(screen.getByText("2. table-reader")).toBeVisible();
    expect(screen.queryByText("Something went wrong")).toBeNull();
  });

  it("Results: the empty state offers the three actions of US-07", async () => {
    serveReplay(emptySearchResponse);

    renderAt(PERMALINK);

    expect(await screen.findByRole("link", { name: "Remove the category filter" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Simplify the description" })).toBeVisible();
    expect(screen.getByRole("link", { name: "extract tables from a pdf" })).toBeVisible();
    expect(screen.getByRole("link", { name: "summarise a changelog" })).toBeVisible();
    // O vazio continua explicado, não é só uma caixa com links.
    expect(screen.getByText(/no skills matched — try broader wording/)).toBeVisible();
    // A tela de resultados não ganha uma segunda lista: quem é `list` é a lista de resultados.
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("Results: removing the category rewrites the draft on the search page", async () => {
    sessionStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({ query: "extract tables from a pdf", category: "documents" }),
    );
    serveReplay(emptySearchResponse);

    renderAt(PERMALINK);
    fireEvent.click(await screen.findByRole("link", { name: "Remove the category filter" }));

    expect(currentLocation()).toBe("/");
    // O texto volta do rascunho; só a categoria foi removida.
    expect(await screen.findByLabelText(/what do you need the skill to do/i)).toHaveValue(
      "extract tables from a pdf",
    );
    await expect(screen.findByRole("option", { name: "Documents" })).resolves.toBeInTheDocument();
    expect(screen.getByLabelText(/category \(optional\)/i)).toHaveValue("");
  });

  it("Results: an example query fills the search box", async () => {
    serveReplay(emptySearchResponse);

    renderAt(PERMALINK);
    fireEvent.click(await screen.findByRole("link", { name: "summarise a changelog" }));

    expect(currentLocation()).toBe("/");
    expect(await screen.findByLabelText(/what do you need the skill to do/i)).toHaveValue(
      "summarise a changelog",
    );
  });

  it("Results: the results region is a named region with a polite live list", async () => {
    serveReplay(searchResponse);

    renderAt(PERMALINK);

    const region = await screen.findByRole("region", { name: "Results" });
    // O `<ol>` de resultados é o único `list` com nome; os `<ul>` de razões dos cartões não têm.
    expect(within(region).getByRole("list", { name: "Results" })).toHaveAttribute(
      "aria-live",
      "polite",
    );
  });
});
