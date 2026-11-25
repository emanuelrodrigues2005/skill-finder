/**
 * O turno de carregamento da conversa: a régua de 3 px pulsando + "Pensando…".
 *
 * Aparece **depois** de 250 ms, não no primeiro frame: uma resposta que chega rápido não deve
 * piscar um indicador que a pessoa nem chegou a ler. Some quando a promessa resolve (o
 * componente sai da árvore).
 *
 * `role="status"` — é o anúncio do pensamento; a régua em si é `aria-hidden` (é cor e forma, e o
 * texto já diz tudo). A animação mora no `GLOBAL_STYLES` de `App.tsx` (classe `.thinking-rule`):
 * `@keyframes` e `@media (prefers-reduced-motion: reduce)` não existem em estilo inline (R7).
 */
import { useEffect, useState } from "react";

import { STR } from "../ui/strings";
import { color, font, space } from "../ui/tokens";

/** Limiar do "pensando". Abaixo disso o indicador pisca e some antes de ser lido. */
export const THINKING_DELAY_MS = 250;

export function ThinkingTurn() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(true);
    }, THINKING_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, []);

  if (!visible) return null;

  return (
    <p
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        gap: space.sm,
        margin: 0,
        color: color.textMuted,
        fontSize: font.size.compact,
      }}
    >
      <span className="thinking-rule" aria-hidden="true" />
      {STR.transcript.status.thinking}
    </p>
  );
}
