/**
 * A pergunta que abriu a conversa, seguida da linha de interpretação.
 *
 * O texto da consulta é dado do usuário: sai como texto puro (o JSX escapa), nunca traduzido e
 * nunca interpretado. Quando a resposta não carrega o texto (permalink antigo, campo `query`
 * ainda não publicado), o turno **não** fica vazio: a linha de interpretação continua dizendo o
 * que o servidor entendeu.
 *
 * A interpretação é um `<p>` só, montado a partir dos `keywords` do `intent`; a categoria só
 * aparece quando não é `null` (regra 3: nada de escrever `n/a` onde o dado simplesmente não veio).
 */
import type { Intent } from "../../types";
import { STR } from "../../ui/strings";
import { color, font, space } from "../../ui/tokens";
import { Turn } from "./Turn";

interface QuestionTurnProps {
  /** Texto digitado, quando conhecido. `null` = a tela não tem a consulta desta resposta. */
  query: string | null;
  intent: Intent;
}

export function QuestionTurn({ query, intent }: QuestionTurnProps) {
  const keywords =
    intent.keywords.length === 0 ? STR.common.na : intent.keywords.join(", ");
  return (
    <Turn tone={color.hairline}>
      {query === null ? null : (
        <p
          style={{
            margin: 0,
            color: color.text,
            fontSize: font.size.lead,
            lineHeight: font.leading.snug,
          }}
        >
          {query}
        </p>
      )}
      <p
        style={{
          margin: query === null ? 0 : `${space.xs} 0 0`,
          color: color.textMuted,
          fontSize: font.size.compact,
        }}
      >
        {STR.transcript.interpretation(intent.category, keywords)}
      </p>
    </Turn>
  );
}
