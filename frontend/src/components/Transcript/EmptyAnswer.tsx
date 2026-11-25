/**
 * O vazio da conversa: nenhuma skill correspondeu, e as três saídas de US-07 AC2.
 *
 * As ações não podem sumir junto do cartão antigo: remover a categoria, simplificar a descrição
 * e tentar um dos exemplos. Cada link volta para `/` levando em `location.state` o que a tela de
 * busca deve mudar — sem essa dica, as três seriam o mesmo link para o formulário. Por isso elas
 * continuam sendo `<Link>`: a dica viaja no state do roteador, não na URL.
 *
 * Não é `<ul>`: o vazio já é um `role="status"` (via `EmptyState`) e a lista de resultados é o
 * único `list` da tela.
 */
import { Link } from "react-router-dom";

import { EmptyState } from "../States";
import { STR } from "../../ui/strings";
import { color, font, space } from "../../ui/tokens";
import { Turn } from "./Turn";

const EXAMPLE_QUERIES = STR.results.emptyActions.examples;

const actionStyle = { color: color.link } as const;
const actionLineStyle = {
  margin: `${space.xs} 0 0`,
  fontSize: font.size.body,
  lineHeight: font.leading.body,
} as const;

interface EmptyAnswerProps {
  /** Lista vazia com `degraded: true` nunca fica sem explicação (regra 7). */
  degraded: boolean;
}

export function EmptyAnswer({ degraded }: EmptyAnswerProps) {
  return (
    <Turn tone={color.border}>
      <EmptyState hint={degraded ? STR.results.empty.degradedHint : undefined} />
      <div
        style={{
          borderTop: `1px solid ${color.hairline}`,
          marginTop: space.md,
          paddingTop: space.md,
        }}
      >
        <p style={{ margin: 0, fontWeight: font.weight.strong, fontSize: font.size.lead }}>
          {STR.results.emptyActions.heading}
        </p>
        <p style={actionLineStyle}>
          <Link to="/" state={{ clearCategory: true }} style={actionStyle}>
            {STR.results.emptyActions.removeCategory}
          </Link>{" "}
          {STR.results.emptyActions.removeCategoryNote}
        </p>
        <p style={actionLineStyle}>
          <Link to="/" style={actionStyle}>
            {STR.results.emptyActions.simplify}
          </Link>{" "}
          {STR.results.emptyActions.simplifyNote}
        </p>
        <p style={actionLineStyle}>
          {STR.results.emptyActions.examplePrefix}{" "}
          {EXAMPLE_QUERIES.map((query, index) => (
            <span key={query}>
              {index === 0 ? null : ", "}
              <Link to="/" state={{ exampleQuery: query }} style={actionStyle}>
                {query}
              </Link>
            </span>
          ))}
        </p>
      </div>
    </Turn>
  );
}
