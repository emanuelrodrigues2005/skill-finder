/**
 * Estados reutilizáveis: loading, empty e error (com `code` e `request_id`).
 *
 * Cada um carrega a mesma gramática visual da régua: uma **marca à esquerda** (uma barra de 3 px
 * na cor do estado) e o texto alinhado a ela. O estado vazio é convite — tracejado, sem
 * dramatismo; o erro é afirmação — borda sólida em `danger`, com o código em mono porque é
 * diagnóstico, não prosa.
 */

import { STR } from "../ui/strings";
import { color, font, radius, space } from "../ui/tokens";
import { CopyText } from "./CopyText";

/**
 * Marca vertical do estado. `aria-hidden`: é cor e forma, e a mesma informação já vem do `role`
 * (`status`/`alert`) mais o texto — repetir na árvore de acessibilidade só faz ruído.
 */
function Rule({ tone }: { tone: string }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-block",
        width: 3,
        alignSelf: "stretch",
        background: tone,
        borderRadius: radius.none,
        flex: "0 0 auto",
      }}
    />
  );
}

interface LoadingStateProps {
  label?: string;
}

export function LoadingState({ label = STR.states.loading.default }: LoadingStateProps) {
  return (
    <p
      role="status"
      aria-live="polite"
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: space.sm,
        margin: 0,
        color: color.textMuted,
        fontSize: font.size.compact,
      }}
    >
      <Rule tone={color.hairline} />
      {label}
    </p>
  );
}

interface EmptyStateProps {
  message?: string;
  hint?: string;
}

export function EmptyState({ message = STR.states.empty.default, hint }: EmptyStateProps) {
  return (
    <div
      role="status"
      style={{
        display: "flex",
        gap: space.md,
        border: `1px dashed ${color.border}`,
        borderRadius: radius.sm,
        padding: space.lg,
        background: color.surface,
      }}
    >
      <Rule tone={color.border} />
      <div>
        <p style={{ margin: 0 }}>{message}</p>
        {hint ? (
          <p style={{ margin: `${space.xs} 0 0`, color: color.textMuted, fontSize: font.size.compact }}>
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  );
}

interface ErrorStateProps {
  message: string;
  requestId?: string | null;
  /**
   * Código que a tela usou para escolher `message` (`describeApiError`). É diagnóstico: a
   * mensagem já é a do mapa de código, nunca o texto do servidor.
   */
  code?: string | null;
  onRetry?: () => void;
}

export function ErrorState({ message, requestId, code = null, onRetry }: ErrorStateProps) {
  return (
    <div
      role="alert"
      style={{
        display: "flex",
        gap: space.md,
        border: `1px solid ${color.danger}`,
        borderRadius: radius.sm,
        padding: space.lg,
        background: color.surface,
      }}
    >
      <Rule tone={color.danger} />
      <div style={{ flex: "1 1 auto" }}>
        <p style={{ margin: 0, fontWeight: font.weight.strong }}>{STR.states.error.title}</p>
        <p style={{ margin: `${space.xs} 0 0`, color: color.textBody }}>{message}</p>
        {code === null ? null : (
          <p
            style={{
              margin: `${space.sm} 0 0`,
              fontSize: font.size.meta,
              color: color.textMuted,
              fontFamily: font.family.mono,
            }}
          >
            {STR.common.codeLabel} <code>{code}</code>
          </p>
        )}
        {requestId ? (
          <div style={{ marginTop: space.sm }}>
            <CopyText label={STR.common.requestIdLabel} value={requestId} />
          </div>
        ) : null}
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            style={{
              marginTop: space.md,
              padding: `${space.xs} ${space.md}`,
              border: `1px solid ${color.link}`,
              borderRadius: radius.sm,
              background: color.surface,
              color: color.link,
              fontFamily: "inherit",
              fontSize: font.size.compact,
              fontWeight: font.weight.strong,
              cursor: "pointer",
            }}
          >
            {STR.states.error.retry}
          </button>
        ) : null}
      </div>
    </div>
  );
}
