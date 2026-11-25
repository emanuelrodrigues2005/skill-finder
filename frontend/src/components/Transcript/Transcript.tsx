/**
 * A transcrição da resposta: pergunta → abertura → tópicos.
 *
 * Interface pública: `<Transcript response searchId />`. Ela **não** lê a rota (nenhum
 * `useSearchParams`, nenhum `useLocation`): o `?search=` entra por prop, então o componente
 * renderiza sozinho — sem roteador e sem rede —, o que é o que o teste de fronteira prova.
 *
 * A folha **não** declara região viva nenhuma (nem na `<ol>`): o anúncio é da linha de status
 * única e persistente da rota (WCAG 4.1.3 — uma região viva por mensagem; uma lista que muda
 * inteira a cada busca anunciava o conteúdo todo de novo). A lista continua `role="list"`
 * explícito, com nome acessível, e na ordem recebida do servidor.
 *
 * O foco inicial é dado **uma vez** por resposta: `ResultsPage` monta com `key={request_id}`,
 * então cada resposta nova ganha um turno focável e o foco do teclado não é roubado a cada
 * re-render (R6).
 */
import { useEffect, useRef } from "react";

import type { SearchResponse } from "../../types";
import { STR, warningLabel } from "../../ui/strings";
import { color, font, space } from "../../ui/tokens";
import { AnswerLead } from "./AnswerLead";
import { DegradedNote } from "./DegradedNote";
import { EmptyAnswer } from "./EmptyAnswer";
import { QuestionTurn } from "./QuestionTurn";
import { TopicItem } from "./TopicItem";
import { carriedQuery } from "./query";

interface TranscriptProps {
  response: SearchResponse;
  /** `?search=` da rota; a folha não lê a URL por conta própria. */
  searchId: string;
}

export function Transcript({ response, searchId }: TranscriptProps) {
  const start = useRef<HTMLDivElement | null>(null);

  // Foco no início da resposta, uma vez: leitor de tela e teclado partem daqui depois do
  // carregamento, sem precisar tabular pelo formulário de novo.
  useEffect(() => {
    start.current?.focus();
  }, []);

  const { results, intent, data, llm, recommendation, warnings } = response;

  return (
    <div ref={start} tabIndex={-1}>
      <QuestionTurn query={carriedQuery(response)} intent={intent} />

      <AnswerLead recommendation={recommendation} count={results.length} />

      <DegradedNote data={data} llmStatus={llm.status} />

      {results.length === 0 ? (
        <EmptyAnswer degraded={data.degraded} />
      ) : (
        <ol
          role="list"
          aria-label={STR.transcript.listLabel}
          style={{ listStyle: "none", padding: 0, margin: `${space.sm} 0 0` }}
        >
          {results.map((item) => (
            <TopicItem
              key={`${item.rank}-${item.skill.skill_id}`}
              item={item}
              searchId={searchId}
            />
          ))}
        </ol>
      )}

      {warnings.length === 0 ? null : (
        <section aria-labelledby="warnings-heading" style={{ marginTop: space.lg }}>
          <h3 id="warnings-heading" style={{ margin: 0, fontSize: font.size.lead }}>
            {STR.results.warnings.heading}
          </h3>
          <ul style={{ color: color.textMuted, fontSize: font.size.small, margin: "0.35rem 0 0" }}>
            {/*
              O aviso é **texto de tela**: o token do contrato (`no_results`, `source_stale`,
              `catalog_enriching`) nunca aparece sozinho como se fosse a frase. Ele continua no
              DOM, em `<code>`, porque é o identificador que o suporte usa — regra 6 sem perder
              o diagnóstico.
            */}
            {warnings.map((warning, index) => (
              <li key={`${String(index)}-${warning}`}>
                {warningLabel(warning)} <code>{warning}</code>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
