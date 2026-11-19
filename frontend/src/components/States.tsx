/** Estados reutilizáveis: loading, empty e error (com `code` e `request_id`). */

import { STR } from "../ui/strings";
import { color, font, radius, space } from "../ui/tokens";
import { CopyText } from "./CopyText";

interface LoadingStateProps {
  label?: string;
}

export function LoadingState({ label = STR.states.loading.default }: LoadingStateProps) {
  return (
    <p role="status" aria-live="polite" style={{ color: color.textMuted }}>
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
      style={{ border: `1px dashed ${color.borderDashed}`, padding: space.lg, borderRadius: radius.md }}
    >
      <p style={{ margin: 0 }}>{message}</p>
      {hint ? <p style={{ margin: `${space.sm} 0 0`, color: color.textMuted }}>{hint}</p> : null}
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
      style={{ border: `1px solid ${color.danger}`, padding: space.lg, borderRadius: radius.md }}
    >
      <p style={{ margin: 0, fontWeight: font.weight.strong }}>{STR.states.error.title}</p>
      <p style={{ margin: `${space.sm} 0 0` }}>{message}</p>
      {code === null ? null : (
        <p style={{ margin: `${space.sm} 0 0`, fontSize: font.size.compact, color: color.textMuted }}>
          {STR.common.codeLabel} <code>{code}</code>
        </p>
      )}
      {requestId ? (
        <div style={{ marginTop: space.sm }}>
          <CopyText label={STR.common.requestIdLabel} value={requestId} />
        </div>
      ) : null}
      {onRetry ? (
        <button type="button" onClick={onRetry} style={{ marginTop: space.md }}>
          {STR.states.error.retry}
        </button>
      ) : null}
    </div>
  );
}
