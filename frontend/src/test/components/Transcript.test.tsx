/**
 * A fronteira da folha: `<Transcript response searchId />` renderiza **direto**.
 *
 * Nenhum roteador, nenhum MSW, nenhuma URL: se um dia a folha voltar a chamar
 * `useSearchParams`/`useLocation` (como `ResultCard` e `RecommendationPanel` faziam) ou a buscar
 * dado por conta própria, este arquivo para de renderizar. O `?search=` entra por prop e o link
 * de cada tópico sai como `href` comum.
 *
 * Os outros casos prendem o que o parecer listou como risco: `recommendation` nullable (R3) e
 * `null` do catálogo em `n/a`, nunca `0` (regra 3 / US-04 AC3).
 */
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { Transcript, type ResponseWithQuery } from "../../components/Transcript";
import type { SearchResponse } from "../../types";
import { nullFieldsResult, searchResponse, topResult } from "../fixtures/search";

const SEARCH_ID = "req_boundary";

describe("Transcript boundary", () => {
  it("renders straight from props, without a router and without MSW", () => {
    render(<Transcript response={searchResponse} searchId={SEARCH_ID} />);

    // Pergunta sem `query` no contrato: a linha de interpretação é quem dá o contexto.
    expect(screen.getByText(/palavras-chave: pdf, extract, table/)).toBeVisible();
    // Resposta em prosa: o texto do servidor, como veio (regra 6).
    expect(screen.getByText("Start with pdf-extract: it handles scanned PDFs.")).toBeVisible();
    // `role="list"` explícito e com nome: a lista não é região viva.
    const list = screen.getByRole("list", { name: "Resultados" });
    expect(list).not.toHaveAttribute("aria-live");
  });

  it("keeps the order the server sent and shows the rank of each topic", () => {
    render(<Transcript response={searchResponse} searchId={SEARCH_ID} />);

    const topics = screen.getAllByRole("listitem");
    expect(topics).toHaveLength(2);
    // O `rank` é dado do contrato: aparece com o nome, e a ordem é a recebida (regra 1).
    expect(within(topics[0]).getByRole("heading", { name: "1. pdf-extract" })).toBeVisible();
    expect(within(topics[1]).getByRole("heading", { name: "2. table-reader" })).toBeVisible();
    // O detalhe da skill leva o `?search=` da busca, para o "voltar" daquela tela funcionar.
    expect(screen.getByRole("link", { name: "1. pdf-extract" })).toHaveAttribute(
      "href",
      `/skills/skl_pdf_extract?search=${SEARCH_ID}`,
    );
  });

  it("renders the query the response carries, when the contract already sends it", () => {
    // `query` ainda não está em `types.ts` (outra frente está acrescentando); a folha o consome
    // por opção, com `?? null`, e o turno mostra o texto quando ele chega.
    const withServerQuery = {
      ...searchResponse,
      query: "extrato de tabelas de um pdf",
    } satisfies ResponseWithQuery;

    render(<Transcript response={withServerQuery} searchId={SEARCH_ID} />);

    expect(screen.getByText("extrato de tabelas de um pdf")).toBeVisible();
  });

  it("never leaves the answer opening empty when the recommendation is null", () => {
    const withoutRecommendation: SearchResponse = {
      ...searchResponse,
      recommendation: null,
    };

    render(<Transcript response={withoutRecommendation} searchId={SEARCH_ID} />);

    // R3: sem prosa do servidor a abertura continua explicando onde está a avaliação.
    expect(screen.getByText("Encontrei 2 skills:")).toBeVisible();
    expect(
      screen.getByText("O ranking abaixo traz a explicação de cada skill."),
    ).toBeVisible();
    // E os tópicos continuam lá: o vazio não engoliu a resposta.
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("shows n/a for a null vulnerability count instead of zero", () => {
    const sparse: SearchResponse = {
      ...searchResponse,
      results: [
        { ...topResult, skill: { ...topResult.skill, vulnerability_count: null } },
      ],
    };

    render(<Transcript response={sparse} searchId={SEARCH_ID} />);

    const topic = screen.getByRole("listitem");
    const term = within(topic).getByText("vulnerabilidades");
    const value = term.nextElementSibling;
    expect(value).toHaveTextContent("n/a");
    // Regra 3: `null` não vira `0` em lugar nenhum do tópico.
    expect(within(topic).queryByText("0")).toBeNull();
  });

  it("says the confidence was low instead of claiming the model was unavailable", () => {
    // R4: `low_confidence` chega com `degraded_reason: llm_unavailable`, mas o modelo respondeu.
    const lowConfidence: SearchResponse = {
      ...searchResponse,
      llm: { ...searchResponse.llm, status: "low_confidence" },
      data: { ...searchResponse.data, degraded: true, degraded_reason: "llm_unavailable" },
    };

    render(<Transcript response={lowConfidence} searchId={SEARCH_ID} />);

    expect(screen.getByText(/pouca confiança/)).toBeVisible();
    expect(screen.queryByText(/indisponível/)).toBeNull();
    // O token do contrato continua visível como diagnóstico.
    expect(screen.getByText("llm_unavailable")).toBeVisible();
  });

  /**
   * O único caso que precisa de roteador: `EmptyAnswer` navega com `<Link>` porque a dica de
   * rascunho (`clearCategory`/`exampleQuery`) viaja no `state` do react-router. A folha em si
   * não precisa — os casos acima renderizam sem nenhum.
   */
  it("explains the empty answer and keeps the three actions of US-07", () => {
    const empty: SearchResponse = {
      ...searchResponse,
      results: [],
      recommendation: null,
    };

    render(
      <MemoryRouter>
        <Transcript response={empty} searchId={SEARCH_ID} />
      </MemoryRouter>,
    );

    expect(screen.getByText(/nenhuma skill correspondeu/)).toBeVisible();
    expect(screen.getByRole("link", { name: "Remover o filtro de categoria" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Simplificar a descrição" })).toBeVisible();
    expect(screen.getByRole("link", { name: "resumir um changelog" })).toBeVisible();
    // O vazio não inventa uma segunda lista: quem é `list` é a lista de resultados.
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("renders a null-heavy topic without inventing numbers", () => {
    const sparse: SearchResponse = {
      ...searchResponse,
      results: [nullFieldsResult],
      recommendation: null,
    };

    render(<Transcript response={sparse} searchId={SEARCH_ID} />);

    const topic = screen.getByRole("listitem");
    expect(within(topic).getAllByText("n/a")).toHaveLength(3);
  });
});
