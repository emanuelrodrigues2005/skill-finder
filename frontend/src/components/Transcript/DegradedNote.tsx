/**
 * A nota de degradação (regra 7: degradação é visível).
 *
 * A frase é escolhida por **dois** campos, não só um: `degraded_reason` diz a categoria grosseira
 * do problema, e `llm.status` diz o que de fato aconteceu. O contrato só tem dois motivos, então
 * `low_confidence` (a LLM respondeu com pouca confiança) chega rotulado como `llm_unavailable`
 * (a LLM não respondeu) — dizer "o modelo está indisponível" nesse caso seria falso (R4).
 *
 * O token do contrato continua na tela, dentro de `<code>`: é o identificador que o suporte usa.
 * A idade do catálogo em horas (US-08 AC2) acompanha o motivo `source_stale`; o `catalog_snapshot`
 * cru não aparece — a frase que importa é "há quanto tempo", não o timestamp ISO.
 */
import type { DegradedReason, LlmStatus, SearchData } from "../../types";
import { STR } from "../../ui/strings";
import { color, font, radius, space } from "../../ui/tokens";
import { ageInHours, show } from "./format";

const HEADLINES: Readonly<Record<DegradedReason, string>> = STR.transcript.degraded.headline;

/** Título da nota. Motivo desconhecido (contrato à frente do bundle) nunca deixa texto vazio. */
function headline(reason: string | null, llmStatus: LlmStatus): string {
  if (reason === "llm_unavailable" && llmStatus === "low_confidence") {
    return STR.transcript.degraded.lowConfidence;
  }
  const headlines: Readonly<Record<string, string | undefined>> = HEADLINES;
  return (reason === null ? undefined : headlines[reason]) ?? STR.transcript.degraded.fallback;
}

interface DegradedNoteProps {
  data: SearchData;
  llmStatus: LlmStatus;
}

export function DegradedNote({ data, llmStatus }: DegradedNoteProps) {
  if (!data.degraded) return null;
  const reason = data.degraded_reason;
  return (
    <div
      style={{
        border: `1px solid ${color.warn}`,
        background: color.warnSurface,
        borderRadius: radius.md,
        padding: `0.6rem ${space.md}`,
        margin: `0 0 ${space.lg}`,
      }}
    >
      <p style={{ margin: 0, fontWeight: font.weight.strong, color: color.text }}>
        {headline(reason, llmStatus)}
      </p>
      <p style={{ margin: "0.35rem 0 0", fontSize: font.size.compact, color: color.warnText }}>
        {STR.transcript.degraded.reasonLabel} <code>{show(reason)}</code>
        {reason === "source_stale"
          ? STR.transcript.degraded.ageSuffix(ageInHours(data.age_seconds), data.age_seconds)
          : null}
      </p>
    </div>
  );
}
