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

    expect(screen.getByText("Carregando categorias…")).toBeVisible();
    // O select chega depois; esperar o fim evita deixar requisição pendente para o próximo teste.
    await expect(screen.findByRole("option", { name: "Documents" })).resolves.toBeInTheDocument();
    expect(screen.queryByText("Carregando categorias…")).toBeNull();
  });

  it("Search: shows the empty state when the catalog has no categories", async () => {
    server.use(
      http.get(apiUrl("/categories"), () => HttpResponse.json({ ...categoriesFixture, data: [] })),
    );

    renderAt("/");

    expect(
      await screen.findByText("nenhuma categoria disponível — você ainda pode buscar sem uma"),
    ).toBeVisible();
  });

  it("Results: shows the loading state while the replay is on its way", async () => {
    serveReplaySlowly();

    renderAt(PERMALINK);

    expect(screen.getByText("Buscando…")).toBeVisible();
    await expect(screen.findByRole("heading", { name: "Resultados" })).resolves.toBeVisible();
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

    expect(screen.getByText("Carregando skill…")).toBeVisible();
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
    expect(alert).toHaveTextContent("Muitas buscas. Tente de novo em 30 segundos.");
    expect(alert).toHaveTextContent("RATE_LIMITED");
    // O resultado anterior continua na tela — o 429 não troca a lista por uma tela de erro.
    expect(screen.getByText("1. pdf-extract")).toBeVisible();
    expect(screen.getByText("2. table-reader")).toBeVisible();
    expect(screen.queryByText("Algo deu errado")).toBeNull();
  });

  it("Results: the empty state offers the three actions of US-07", async () => {
    serveReplay(emptySearchResponse);

    renderAt(PERMALINK);

    expect(
      await screen.findByRole("link", { name: "Remover o filtro de categoria" }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Simplificar a descrição" })).toBeVisible();
    expect(screen.getByRole("link", { name: "extrair tabelas de um pdf" })).toBeVisible();
    expect(screen.getByRole("link", { name: "resumir um changelog" })).toBeVisible();
    // O vazio continua explicado, não é só uma caixa com links.
    expect(screen.getByText(/nenhuma skill correspondeu — tente palavras mais amplas/)).toBeVisible();
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
    fireEvent.click(await screen.findByRole("link", { name: "Remover o filtro de categoria" }));

    expect(currentLocation()).toBe("/");
    // O texto volta do rascunho; só a categoria foi removida.
    expect(await screen.findByLabelText(/o que você precisa que a skill faça/i)).toHaveValue(
      "extract tables from a pdf",
    );
    await expect(screen.findByRole("option", { name: "Documents" })).resolves.toBeInTheDocument();
    expect(screen.getByLabelText(/categoria \(opcional\)/i)).toHaveValue("");
  });

  it("Results: an example query fills the search box", async () => {
    serveReplay(emptySearchResponse);

    renderAt(PERMALINK);
    fireEvent.click(await screen.findByRole("link", { name: "resumir um changelog" }));

    expect(currentLocation()).toBe("/");
    expect(await screen.findByLabelText(/o que você precisa que a skill faça/i)).toHaveValue(
      "resumir um changelog",
    );
  });

  it("Results: the results region is a named region with a polite live list", async () => {
    serveReplay(searchResponse);

    renderAt(PERMALINK);

    const region = await screen.findByRole("region", { name: "Resultados" });
    // O `<ol>` de resultados é o único `list` com nome; os `<ul>` de razões dos cartões não têm.
    expect(within(region).getByRole("list", { name: "Resultados" })).toHaveAttribute(
      "aria-live",
      "polite",
    );
  });
});
