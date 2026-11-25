import { Link, Navigate, Route, Routes } from "react-router-dom";

import DetailPage from "./pages/DetailPage";
import ResultsPage from "./pages/ResultsPage";
import SearchPage from "./pages/SearchPage";
import { STR } from "./ui/strings";
import { color, focusRing, font, measure, space } from "./ui/tokens";

/**
 * Foco visível, skip link, o papel da página (issue #28, `docs/app/01-spec-produto.md` §6.6) e o
 * pulso do "pensando" (classe `.thinking-rule`, usada por `ThinkingTurn` e pela linha de status).
 *
 * O projeto não tem folha de estilo: cada componente carrega o próprio `style` inline e
 * `:focus-visible` não existe em estilo inline. Este bloco é o único CSS global — o contorno de
 * **3 px** vale para todo controle focável, o skip link só aparece quando recebe foco, e o `body`
 * recebe o papel (`color.bg`): sem isto a margem padrão do navegador criava uma moldura branca em
 * volta do papel. Ficar no documento (em vez de um `.css` importado) é o que torna o critério
 * verificável sem navegador: a suíte lê este texto em `document.querySelector("style")`.
 *
 * Os valores vêm de `ui/tokens.ts` e são interpolados como hex literal: o teste de contraste lê o
 * valor computado, não o nome do token.
 */
const GLOBAL_STYLES = `
html, body {
  margin: 0;
  background: ${color.bg};
}
body {
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
:focus-visible {
  outline: ${focusRing.outline};
  outline-offset: ${focusRing.offset}px;
}
.skip-link {
  position: absolute;
  top: 0;
  left: -9999px;
  padding: ${space.sm} ${space.md};
  background: ${color.link};
  color: ${color.onLink};
  border-radius: 0 0 4px 0;
  z-index: 10;
}
.skip-link:focus,
.skip-link:focus-visible {
  left: 0;
}
.thinking-rule {
  display: inline-block;
  flex: 0 0 auto;
  align-self: stretch;
  width: 3px;
  min-height: 1em;
  background: ${color.link};
  animation: thinking-pulse 1.1s ease-in-out infinite;
}
@keyframes thinking-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
/*
 * A primeira media query do projeto, e a razão de o pulso não estar no estilo inline: o "pensando"
 * respira em opacidade, e quem pediu menos movimento no sistema recebe a régua parada. Uma
 * animação declarada inline venceria qualquer regra de media query — por isso a classe.
 */
@media (prefers-reduced-motion: reduce) {
  .thinking-rule {
    animation: none;
  }
}
`;

export default function App() {
  return (
    <div
      style={{
        fontFamily: font.family.sans,
        background: color.bg,
        color: color.text,
        minHeight: "100vh",
        fontSize: font.size.body,
        lineHeight: font.leading.body,
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

      {/*
        Cabeçalho fino, com uma régua de 1 px separando a marca do conteúdo. A régua é
        estrutural: marca onde acaba o "chrome" e começa a superfície de trabalho — o mesmo
        vocabulário de medida que a lista de resultados usa.
      */}
      <header
        style={{
          borderBottom: `1px solid ${color.hairline}`,
          background: color.bg,
        }}
      >
        <div
          style={{
            maxWidth: measure.page,
            margin: "0 auto",
            padding: `${space.lg} ${space.lg} ${space.md}`,
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            gap: space.md,
            flexWrap: "wrap",
          }}
        >
          <div>
            <Link to="/" style={{ textDecoration: "none", color: "inherit" }}>
              <h1
                style={{
                  fontSize: font.size.display,
                  fontWeight: font.weight.black,
                  letterSpacing: font.tracking.tight,
                  lineHeight: font.leading.tight,
                  margin: 0,
                }}
              >
                {STR.app.title}
              </h1>
            </Link>
            <p
              style={{
                margin: `${space.xs} 0 0`,
                color: color.textMuted,
                fontSize: font.size.compact,
              }}
            >
              {STR.app.tagline}
            </p>
          </div>
        </div>
      </header>

      {/* `tabIndex={-1}`: o `#results` recebe foco pelo skip link sem entrar na ordem de tabulação. */}
      <main
        id="results"
        tabIndex={-1}
        style={{
          maxWidth: measure.page,
          margin: "0 auto",
          padding: `${space.xl} ${space.lg} ${space.xxxl}`,
        }}
      >
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
