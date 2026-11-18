/** Estados reutilizáveis: loading, empty e error (com `code` e `request_id`). */

import { STR } from "../ui/strings";
import { CopyText } from "./CopyText";

interface LoadingStateProps {
  label?: string;
}

export function LoadingState({ label = STR.states.loading.default }: LoadingStateProps) {
  return (
    <p role="status" aria-live="polite" style={{ color: "#475569" }}>
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
    <div role="status" style={{ border: "1px dashed #cbd5e1", padding: "1rem", borderRadius: 8 }}>
      <p style={{ margin: 0 }}>{message}</p>
      {hint ? <p style={{ margin: "0.5rem 0 0", color: "#475569" }}>{hint}</p> : null}
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
    <div role="alert" style={{ border: "1px solid #f87171", padding: "1rem", borderRadius: 8 }}>
      <p style={{ margin: 0, fontWeight: 600 }}>{STR.states.error.title}</p>
      <p style={{ margin: "0.5rem 0 0" }}>{message}</p>
      {code === null ? null : (
        <p style={{ margin: "0.5rem 0 0", fontSize: "0.85rem", color: "#475569" }}>
          {STR.common.codeLabel} <code>{code}</code>
        </p>
      )}
      {requestId ? (
        <div style={{ marginTop: "0.5rem" }}>
          <CopyText label={STR.common.requestIdLabel} value={requestId} />
        </div>
      ) : null}
      {onRetry ? (
        <button type="button" onClick={onRetry} style={{ marginTop: "0.75rem" }}>
          {STR.states.error.retry}
        </button>
      ) : null}
    </div>
  );
}
