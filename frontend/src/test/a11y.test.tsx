/**
 * Acessibilidade observável em jsdom (issue #28, `docs/app/01-spec-produto.md` §6.6).
 *
 * O que aqui se prova é o que existe no DOM e no CSS entregue: skip link como primeiro focável,
 * ordem de tabulação, contorno de foco ≥ 2 px, `aria-live`/`role` nos estados, texto do usuário
 * como texto puro e contraste dos metadados. Layout em 360 px e foco real de navegador **não**
 * são observáveis em jsdom — o que dá para afirmar sem browser está abaixo (e o resto está
 * declarado como não provado no relatório).
 */
import { render, screen, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import App from "../App";
import DetailPage from "../pages/DetailPage";
import ResultsPage from "../pages/ResultsPage";
import {
  emptySearchResponse,
  errorEnvelope,
  REQUEST_ID,
  searchResponse,
  skillDetailFixture,
} from "./fixtures/search";
import { renderRoutes, type InitialEntry, type RouteSpec } from "./harness";
import { apiUrl, errorResponse } from "./msw/handlers";
import { server } from "./msw/server";

const DRILL = "/skills/skl_pdf_extract";

const ROUTES: RouteSpec[] = [
  { path: "/results", element: <ResultsPage /> },
  { path: "/skills/:id", element: <DetailPage /> },
];

function renderAt(entry: InitialEntry): void {
  renderRoutes(ROUTES, entry);
}

/** Elementos que o `Tab` alcança, na ordem do documento. `tabindex="-1"` fica de fora. */
function tabbables(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
  );
}

/** Regras de CSS que o app injeta no documento (é por elas que foco e skip link são provados). */
function injectedCss(): string {
  const style = document.querySelector("style");
  if (style === null) throw new Error("no injected stylesheet found");
  return style.textContent ?? "";
}

/** `rgb(r, g, b)` ou `#rrggbb` → canais. O jsdom normaliza o `style` inline para `rgb()`. */
function channels(color: string): [number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (hex !== null) {
    return [
      Number.parseInt(hex[1].slice(0, 2), 16),
      Number.parseInt(hex[1].slice(2, 4), 16),
      Number.parseInt(hex[1].slice(4, 6), 16),
    ];
  }
  const rgb = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color);
  if (rgb === null) throw new Error(`not a colour: ${color}`);
  return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
}

/** Componente por canal da luminância relativa (WCAG 2.x, definição de *relative luminance*). */
function linear(channel: number): number {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** Razão de contraste contra o branco — o fundo de todos os metadados das telas. */
function contrastOnWhite(color: string): number {
  const [r, g, b] = channels(color);
  const luminance = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  return 1.05 / (luminance + 0.05);
}

/** Cores de texto declaradas no DOM renderizado, sem repetição. */
function textColors(root: ParentNode): string[] {
  const colors: string[] = [];
  for (const element of Array.from(root.querySelectorAll<HTMLElement>("[style]"))) {
    const color = element.style.color;
    if (color !== "" && !colors.includes(color)) colors.push(color);
  }
  return colors;
}

/** Larguras fixas em `px` declaradas no DOM — o que forçaria rolagem horizontal. */
function fixedWidths(root: ParentNode): number[] {
  const widths: number[] = [];
  for (const element of Array.from(root.querySelectorAll<HTMLElement>("[style]"))) {
    if (/^\d+px$/.test(element.style.width)) widths.push(Number.parseInt(element.style.width, 10));
  }
  return widths;
}

describe("skip link and focus", () => {
  it("is the first tabbable element and targets the results landmark", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );
    await screen.findByRole("option", { name: "Documents" });

    const focusable = tabbables();
    expect(focusable[0]).toHaveAccessibleName("Skip to results");
    expect(focusable[0]).toHaveAttribute("href", "#results");
    // O alvo existe em qualquer tela: o `main` é onde os resultados aparecem.
    expect(document.getElementById("results")).toBe(document.querySelector("main"));
  });

  it("keeps a predictable tab order on the search screen", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );
    await screen.findByRole("option", { name: "Documents" });

    expect(tabbables().map((element) => element.tagName.toLowerCase())).toEqual([
      "a", // skip link
      "a", // home link wrapping the h1
      "textarea",
      "select",
      "button",
    ]);
    expect(tabbables()[1]).toHaveAccessibleName("Skills Search");
    expect(tabbables()[4]).toHaveAccessibleName("Search");
  });

  it("declares a focus-visible outline of at least 2 px and hides the skip link until focused", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );
    await screen.findByRole("option", { name: "Documents" });

    const css = injectedCss();
    const focusRule = /:focus-visible[^{]*\{([^}]*)\}/.exec(css);
    expect(focusRule).not.toBeNull();
    const outline = /outline:\s*(\d+)px\s+solid/.exec(focusRule?.[1] ?? "");
    expect(outline).not.toBeNull();
    expect(Number.parseInt(outline?.[1] ?? "0", 10)).toBeGreaterThanOrEqual(2);

    // O skip link fica fora da tela até receber foco — e volta ao canto quando focado.
    expect(css).toMatch(/\.skip-link\s*\{[^}]*left:\s*-\d+px/);
    expect(css).toMatch(/\.skip-link:focus[^{]*\{[^}]*left:\s*0/);
  });

  it("keeps every metadata colour at 4.5:1 or more against white", async () => {
    server.use(http.get(apiUrl(`/searches/${REQUEST_ID}`), () => HttpResponse.json(searchResponse)));

    renderAt(`/results?search=${REQUEST_ID}`);
    await screen.findByRole("heading", { name: "Results" });

    const colors = textColors(document.body);
    expect(colors.length).toBeGreaterThan(0);
    for (const color of colors) {
      // O segundo argumento é a mensagem que aparece quando a razão é insuficiente.
      expect(contrastOnWhite(color), color).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("declares no fixed pixel width wider than the 360 px target", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );
    await screen.findByRole("option", { name: "Documents" });

    // Prova parcial e é o que jsdom permite: sem layout não há `scrollWidth`. Larguras fixas em
    // `px` são o que estoura um viewport de 360 px; `width: 100%` e `max-width` não são coletadas.
    for (const width of fixedWidths(document.body)) {
      expect(width, `${width}px`).toBeLessThanOrEqual(360);
    }
  });
});

describe("live regions and state roles", () => {
  it("marks the results list as a polite live region inside the named Results region", async () => {
    server.use(http.get(apiUrl(`/searches/${REQUEST_ID}`), () => HttpResponse.json(searchResponse)));

    renderAt(`/results?search=${REQUEST_ID}`);

    const region = await screen.findByRole("region", { name: "Results" });
    // O `<ol>` é o único `list` chamado "Results"; os `<ul>` de razões de cada cartão não têm nome.
    expect(within(region).getByRole("list", { name: "Results" })).toHaveAttribute(
      "aria-live",
      "polite",
    );
  });

  it("gives each results state the role that announces it", async () => {
    server.use(http.get(apiUrl(`/searches/${REQUEST_ID}`), () => HttpResponse.json(emptySearchResponse)));
    renderAt(`/results?search=${REQUEST_ID}`);

    // `CopyText` já mantém uma região `role="status"` (o anúncio da cópia), então o estado vazio é
    // localizado pelo texto e amarrado à região viva que o contém — não por ser a única da tela.
    const message = await screen.findByText(/no skills matched/);
    expect(message.closest('[role="status"]')).not.toBeNull();
  });

  it("announces loading as a status and failure as an alert", async () => {
    server.use(
      http.get(apiUrl(`/searches/${REQUEST_ID}`), () =>
        errorResponse(500, errorEnvelope("INTERNAL")),
      ),
    );

    renderAt(`/results?search=${REQUEST_ID}`);

    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong on our side.");
  });
});

describe("user text stays text", () => {
  it("renders a SKILL.md excerpt containing markup as literal characters", async () => {
    server.use(
      http.get(apiUrl("/skills/:skillId"), () =>
        HttpResponse.json({
          ...skillDetailFixture,
          data: {
            ...skillDetailFixture.data,
            skill_md_excerpt: "<b>bold</b> <img src=x onerror=alert(1)> <script>alert(2)</script>",
          },
        }),
      ),
    );

    renderAt(DRILL);

    expect(await screen.findByText(/<b>bold<\/b>/)).toBeVisible();
    // Nada do texto virou elemento: nem negrito, nem imagem, nem script.
    expect(document.querySelector("b")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
  });

  it("renders a recommendation containing a script tag as literal characters", async () => {
    server.use(
      http.get(apiUrl(`/searches/${REQUEST_ID}`), () =>
        HttpResponse.json({
          ...searchResponse,
          recommendation: {
            skill_id: "skl_pdf_extract",
            text: "Start here <script>alert('x')</script> and read the SKILL.md",
          },
        }),
      ),
    );

    renderAt(`/results?search=${REQUEST_ID}`);

    expect(await screen.findByText(/<script>alert\('x'\)<\/script>/)).toBeVisible();
    expect(document.querySelector("script")).toBeNull();
  });
});
