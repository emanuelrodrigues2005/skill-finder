import { useState } from "react";

/**
 * Valor copiável (permalink, `request_id`) com feedback anunciado (`aria-live`).
 *
 * `navigator.clipboard` só existe em contexto seguro (https ou localhost). Em http comum a
 * alternativa é um `input` `readOnly` que seleciona o texto ao receber foco — a pessoa copia com
 * Ctrl+C. `document.execCommand` é obsoleto e não é usado aqui.
 */
interface CopyTextProps {
  /** Rótulo curto em inglês, exibido antes do valor (`permalink`, `request_id`). */
  label: string;
  value: string;
}

type Outcome = "copied" | "copy-failed";

/**
 * Duas redações por desfecho. A região viva só é anunciada quando o **texto muda**, e a ação que
 * a pessoa repete é sempre a mesma cópia: sem alternar a frase, a segunda cópia gravaria a mesma
 * string e o leitor de tela ficaria mudo. O par alternado garante mutação a cada tentativa.
 */
const MESSAGES: Readonly<Record<Outcome, readonly [string, string]>> = {
  copied: ["Copied.", "Copied again."],
  "copy-failed": [
    "Could not copy — select the text and press Ctrl+C.",
    "Still could not copy — select the text and press Ctrl+C.",
  ],
};

interface Announcement {
  outcome: Outcome;
  /** Tentativa de cópia, 1-based. `0` = nada a anunciar: a região fica vazia. */
  attempt: number;
}

const NOTHING_TO_ANNOUNCE: Announcement = { outcome: "copied", attempt: 0 };

function announcementText({ outcome, attempt }: Announcement): string {
  return attempt === 0 ? "" : MESSAGES[outcome][(attempt - 1) % 2];
}

export function CopyText({ label, value }: CopyTextProps) {
  const [announcement, setAnnouncement] = useState<Announcement>(NOTHING_TO_ANNOUNCE);
  // Lido no render: o contexto seguro não muda depois que a página carregou.
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;

  async function handleCopy() {
    let outcome: Outcome = "copied";
    try {
      // `?.` porque a API some fora de contexto seguro.
      await clipboard?.writeText(value);
    } catch {
      outcome = "copy-failed";
    }
    // Só o `attempt` avança: a alternância da frase acompanha o gesto, não o resultado.
    setAnnouncement((current) => ({ outcome, attempt: current.attempt + 1 }));
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
      {clipboard ? (
        <>
          <code style={{ fontSize: "0.85rem", wordBreak: "break-all" }}>
            {label}: {value}
          </code>
          <button type="button" onClick={handleCopy}>
            Copy
          </button>
        </>
      ) : (
        <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", width: "100%" }}>
          <span style={{ fontSize: "0.85rem" }}>{label}:</span>
          <input
            readOnly
            value={value}
            // O `<label>` também envolve o `<input>`: sem isto o nome acessível viraria
            // `permalink: https://…` inteiro, valor incluído.
            aria-label={label}
            onFocus={(event) => event.currentTarget.select()}
            onClick={(event) => event.currentTarget.select()}
            style={{ flex: 1, fontFamily: "monospace", fontSize: "0.85rem", padding: "0.25rem" }}
          />
        </label>
      )}
      {/*
        A região existe desde o primeiro render, vazia: um leitor de tela precisa observar a
        região *antes* da mutação. Inserida junto com o texto, ela geralmente não é anunciada.
      */}
      <span role="status" aria-live="polite" style={{ fontSize: "0.85rem", color: "#475569" }}>
        {announcementText(announcement)}
      </span>
    </div>
  );
}
