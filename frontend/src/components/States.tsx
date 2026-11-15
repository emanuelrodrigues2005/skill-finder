/** Estados reutilizáveis: loading, empty e error (com `request_id`). */

interface LoadingStateProps {
  label?: string;
}

export function LoadingState({ label = "Loading…" }: LoadingStateProps) {
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

export function EmptyState({
  message = "no skills matched — try broader wording",
  hint,
}: EmptyStateProps) {
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
  onRetry?: () => void;
}

export function ErrorState({ message, requestId, onRetry }: ErrorStateProps) {
  return (
    <div role="alert" style={{ border: "1px solid #f87171", padding: "1rem", borderRadius: 8 }}>
      <p style={{ margin: 0, fontWeight: 600 }}>Something went wrong</p>
      <p style={{ margin: "0.5rem 0 0" }}>{message}</p>
      {requestId ? (
        <p style={{ margin: "0.5rem 0 0", fontFamily: "monospace", fontSize: "0.85rem" }}>
          request_id: {requestId}
        </p>
      ) : null}
      {onRetry ? (
        <button type="button" onClick={onRetry} style={{ marginTop: "0.75rem" }}>
          Try again
        </button>
      ) : null}
    </div>
  );
}
