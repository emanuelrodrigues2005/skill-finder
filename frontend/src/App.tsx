import { Link, Navigate, Route, Routes } from "react-router-dom";

import DetailPage from "./pages/DetailPage";
import ResultsPage from "./pages/ResultsPage";
import SearchPage from "./pages/SearchPage";
import { STR } from "./ui/strings";

/**
 * Foco visível e skip link (issue #28, `docs/app/01-spec-produto.md` §6.6).
 *
 * O projeto não tem folha de estilo: cada componente carrega o próprio `style` inline, e
 * `:focus-visible` não existe em estilo inline. Este bloco é o único CSS global — o contorno de
 * **3 px** vale para todo controle focável e o skip link só aparece quando recebe foco. Ficar no
 * documento (em vez de um `.css` importado) também é o que torna o critério verificável sem
 * navegador: a suíte lê este texto em `document.querySelector("style")`.
 */
const GLOBAL_STYLES = `
:focus-visible {
  outline: 3px solid #1d4ed8;
  outline-offset: 2px;
}
.skip-link {
  position: absolute;
  top: 0;
  left: -9999px;
  padding: 0.5rem 0.75rem;
  background: #1d4ed8;
  color: #ffffff;
  border-radius: 0 0 8px 0;
  z-index: 10;
}
.skip-link:focus,
.skip-link:focus-visible {
  left: 0;
}
`;

export default function App() {
  return (
    <div
      style={{
        fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
        margin: "0 auto",
        maxWidth: 880,
        padding: "1.5rem 1rem 3rem",
        color: "#0f172a",
      }}
    >
      <style>{GLOBAL_STYLES}</style>
      {/*
        Primeiro elemento focável do documento: um `Tab` chega nele antes da navegação e do
        formulário. O alvo é `#results` — o `<main>` é a região onde os resultados aparecem em
        todas as telas, então o link nunca aponta para um id inexistente (Search e Detail incluídos).
      */}
      <a className="skip-link" href="#results">
        {STR.app.skipToResults}
      </a>
      <header style={{ marginBottom: "1.5rem" }}>
        <Link to="/" style={{ textDecoration: "none", color: "inherit" }}>
          <h1 style={{ fontSize: "1.4rem", margin: 0 }}>{STR.app.title}</h1>
        </Link>
        <p style={{ margin: "0.25rem 0 0", color: "#475569" }}>{STR.app.tagline}</p>
      </header>
      {/* `tabIndex={-1}`: o `#results` recebe foco pelo skip link sem entrar na ordem de tabulação. */}
      <main id="results" tabIndex={-1}>
        <Routes>
          <Route path="/" element={<SearchPage />} />
          <Route path="/results" element={<ResultsPage />} />
          <Route path="/skills/:id" element={<DetailPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
