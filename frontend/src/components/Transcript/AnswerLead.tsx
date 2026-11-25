/**
 * A abertura da resposta: quantas skills vieram e a prosa do servidor.
 *
 * `recommendation.text` é a prosa que o backend redigiu — dado do servidor, mostrado como veio,
 * nunca traduzido nem reescrito (regra 6). O contrato o declara **nullable** (R3), e uma
 * resposta degradada chega sem ele: nesse caso a abertura não fica num buraco. A supressão é
 * explícita — uma frase que diz onde está a explicação — em vez de repetir
 * `results[0].explanation`, que aparece no tópico logo abaixo.
 */
import type { Recommendation } from "../../types";
import { STR } from "../../ui/strings";
import { color, font, space } from "../../ui/tokens";
import { Turn } from "./Turn";

interface AnswerLeadProps {
  recommendation: Recommendation | null;
  /** Quantos tópicos a resposta traz — é o que a abertura conta. */
  count: number;
}

/** Abertura por contagem: nenhum resultado, um, vários. Nunca um número inventado. */
function opening(count: number): string {
  if (count === 0) return STR.transcript.lead.none;
  if (count === 1) return STR.transcript.lead.one;
  return STR.transcript.lead.many(count);
}

export function AnswerLead({ recommendation, count }: AnswerLeadProps) {
  const prose = recommendation === null ? null : recommendation.text.trim();
  // Lista vazia: não há o que abrir em prosa — o `EmptyAnswer` é quem explica o vazio.
  const fallback = count === 0 ? null : STR.transcript.lead.noProse;
  const body = prose === null || prose === "" ? fallback : prose;
  return (
    <Turn tone={color.link}>
      <p
        style={{
          margin: 0,
          fontFamily: font.family.mono,
          fontSize: font.size.meta,
          color: color.textMuted,
        }}
      >
        {opening(count)}
      </p>
      {body === null ? null : (
        <p
          style={{
            margin: `${space.sm} 0 0`,
            color: color.textBody,
            fontSize: font.size.body,
            lineHeight: font.leading.body,
            maxWidth: "68ch",
          }}
        >
          {body}
        </p>
      )}
    </Turn>
  );
}
