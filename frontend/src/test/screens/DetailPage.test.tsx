/**
 * Tela de detalhe (issue #29) — três casos: resposta com campos ausentes, `SKILL.md` fora do
 * catálogo e `404 NOT_FOUND` com `request_id` preservado para o suporte.
 */
import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import DetailPage from "../../pages/DetailPage";
import { errorEnvelope, REQUEST_ID, skillDetailFixture } from "../fixtures/search";
import { renderRoutes, type InitialEntry, type RouteSpec } from "../harness";
import { apiUrl, errorResponse } from "../msw/handlers";
import { server } from "../msw/server";

const SKILL_PATH = "/skills/skl_pdf_extract";

const ROUTES: RouteSpec[] = [
  { path: "/skills/:id", element: <DetailPage /> },
  { path: "/", element: <p>search screen</p> },
  { path: "/results", element: <p>results screen</p> },
];

/**
 * Valor do `<dd>` de um termo da ficha (`<dl>` do detalhe). O filtro por `tagName` existe porque
 * `SKILL.md` aparece duas vezes na tela — como `<dt>` e como título da seção do documento.
 */
function detailValue(label: string): HTMLElement {
  const term = screen.getAllByText(label).find((node) => node.tagName === "DT");
  const value = term?.nextElementSibling;
  if (term === undefined || !(value instanceof HTMLElement)) {
    throw new Error(`no <dd> rendered for "${label}"`);
  }
  return value;
}

function renderDetail(entry: InitialEntry = SKILL_PATH): void {
  renderRoutes(ROUTES, entry);
}

describe("DetailPage", () => {
  it("renders n/a for absent fields and a safe external link", async () => {
    renderDetail();

    expect(await screen.findByRole("heading", { name: "pdf-extract" })).toBeVisible();
    // Contrato: `stars`, `installs`, `vulnerability_count` e `repo_url` vieram `null`.
    expect(detailValue("Stars")).toHaveTextContent("n/a");
    expect(detailValue("Installs")).toHaveTextContent("n/a");
    expect(detailValue("Vulnerabilities")).toHaveTextContent("n/a");
    expect(detailValue("Repository")).toHaveTextContent("n/a");
    expect(detailValue("SKILL.md")).toHaveTextContent("present");

    const source = screen.getByRole("link", { name: skillDetailFixture.data.source_url });
    expect(source).toHaveAttribute("href", skillDetailFixture.data.source_url);
    expect(source).toHaveAttribute("target", "_blank");
    expect(source).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("explains when the catalog has no SKILL.md for the skill", async () => {
    server.use(
      http.get(apiUrl(`${SKILL_PATH}`), () =>
        HttpResponse.json({
          ...skillDetailFixture,
          data: { ...skillDetailFixture.data, skill_md_present: false, skill_md_excerpt: null },
        }),
      ),
    );

    renderDetail();

    expect(await screen.findByText("No full description available for this skill")).toBeVisible();
    expect(screen.getByText("SKILL.md: n/a")).toBeVisible();
    expect(detailValue("SKILL.md")).toHaveTextContent("n/a");
  });

  it("keeps the request id on a missing skill", async () => {
    server.use(
      http.get(
        apiUrl(`${SKILL_PATH}`),
        () => errorResponse(404, errorEnvelope("NOT_FOUND", { requestId: REQUEST_ID })),
      ),
    );

    renderDetail();

    expect(await screen.findByText("Skill not found")).toBeVisible();
    expect(screen.queryByText(/server said:/)).toBeNull();
    expect(screen.getByLabelText("request_id")).toHaveValue(REQUEST_ID);
  });
});
