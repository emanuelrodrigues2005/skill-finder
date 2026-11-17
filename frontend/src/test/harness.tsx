import { render, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

/**
 * Harness das telas (issue #29): renderiza a página dentro de um `MemoryRouter` com as rotas
 * vizinhas e deixa a URL corrente visível em `data-testid="location"`.
 *
 * É por esse marcador que "navegou" e "não navegou" são provados — a URL é o efeito observável
 * da navegação, e não um detalhe interno do componente.
 */

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

export interface RouteSpec {
  /** Padrão do `react-router` (`/results`, `/skills/:id`). */
  path: string;
  element: ReactElement;
}

/** Entrada inicial: caminho puro ou objeto com `state` (é como `/results` recebe a resposta). */
export type InitialEntry = string | { pathname: string; search?: string; state?: unknown };

/** URL corrente, do jeito que o teste compara (`/results?search=req_…`). */
export function currentLocation(): string {
  return document.querySelector('[data-testid="location"]')?.textContent ?? "";
}

export function renderRoutes(routes: RouteSpec[], initialEntry: InitialEntry): RenderResult {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <LocationProbe />
      <Routes>
        {routes.map((route) => (
          <Route key={route.path} path={route.path} element={route.element} />
        ))}
      </Routes>
    </MemoryRouter>,
  );
}
