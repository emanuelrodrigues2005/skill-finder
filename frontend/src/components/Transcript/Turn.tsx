/**
 * O turno da conversa: régua de 3 px à esquerda + espaçamento vertical.
 *
 * A régua é a gramática visual da folha (`States.tsx` já a usa): ela marca onde começa uma fala
 * sem desenhar uma caixa em volta dela. Três turnos usam isto — a pergunta, a abertura da
 * resposta e o vazio — e nenhum deles escolhe o próprio espaçamento.
 */
import type { ReactNode } from "react";

import { radius, space } from "../../ui/tokens";

interface TurnProps {
  children: ReactNode;
  /** Cor da régua, sempre vinda de `ui/tokens` (`color.*`). */
  tone: string;
}

export function Turn({ children, tone }: TurnProps) {
  return (
    <div style={{ display: "flex", gap: space.md, padding: `${space.md} 0` }}>
      <span
        aria-hidden="true"
        style={{
          display: "inline-block",
          flex: "0 0 auto",
          width: 3,
          alignSelf: "stretch",
          background: tone,
          borderRadius: radius.none,
        }}
      />
      <div style={{ flex: "1 1 auto", minWidth: 0 }}>{children}</div>
    </div>
  );
}
