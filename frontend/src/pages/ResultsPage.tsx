import { useEffect, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";

import { ApiError, describeApiError, getSearch } from "../api";
import { CopyText } from "../components/CopyText";
import { EmptyState, ErrorState, LoadingState } from "../components/States";
import type { ResultItem, SearchResponse } from "../types";

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: SearchResponse }
  | { status: "error"; message: string; code: string | null; requestId: string | null };

/** O que a tela de busca entrega na navegação: a resposta já pronta, sem segundo `POST`. */
interface LocationState {
  response?: SearchResponse;
}

function show(value: string | number | null): string {
  return value === null ? "n/a" : String(value);
}

function Meta({ item }: { item: ResultItem }) {
  const { skill } = item;
  return (
    <p style={{ margin: "0.35rem 0 0", fontSize: "0.8rem", color: "#475569" }}>
      category {show(skill.category)} · stars {show(skill.stars)} · installs{" "}
      {show(skill.installs)} · vulns {show(skill.vulnerability_count)}
      {skill.skill_md_present ? "" : " · SKILL.md n/a"}
    </p>
  );
}

export default function ResultsPage() {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const permalinkId = (searchParams.get("search") ?? "").trim();
  // A busca recém-feita chega em `location.state`, que o react-router v6 guarda em `history.state`
  // e o navegador **restaura** no reload: o F5 de `/results?search=…` depois de uma busca nesta
  // aba reusa a resposta em memória e não chama `getSearch`. O caminho `GET
  // /api/v1/searches/{request_id}` só roda em aba nova, URL colada ou state limpo — é por isso
  // que a prova do permalink é aba nova/anônima, nunca reload in-place.
  const stateResponse = (location.state as LocationState | null)?.response ?? null;
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState<LoadState>(() => {
    if (stateResponse) return { status: "ready", data: stateResponse };
    return permalinkId === "" ? { status: "idle" } : { status: "loading" };
  });

  useEffect(() => {
    if (stateResponse) {
      setState({ status: "ready", data: stateResponse });
      return;
    }
    if (permalinkId === "") {
      setState({ status: "idle" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    // `GET /api/v1/searches/{request_id}`: o permalink é endereçado pelo `request_id`.
    getSearch(permalinkId)
      .then((data) => {
        if (!cancelled) setState({ status: "ready", data });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const described = describeApiError(error);
        setState({
          status: "error",
          message: described.message,
          code: described.code,
          requestId: error instanceof ApiError ? error.requestId : null,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [permalinkId, stateResponse, reloadKey]);

  if (state.status === "idle") {
    return <EmptyState message="no search yet — describe the skill you need on the search page" />;
  }

  if (state.status === "loading") {
    return <LoadingState label="Searching…" />;
  }

  if (state.status === "error") {
    return (
      <ErrorState
        message={state.message}
        code={state.code}
        requestId={state.requestId}
        onRetry={() => setReloadKey((key) => key + 1)}
      />
    );
  }

  const { request_id, results, data, intent, recommendation, warnings } = state.data;
  const permalink = `${window.location.origin}/results?search=${encodeURIComponent(request_id)}`;

  return (
    <section>
      <h2 style={{ fontSize: "1.1rem" }}>Results</h2>

      {/* Permalink estável: endereçado pelo `request_id`, a mesma resposta em aba nova ou ao
          compartilhar. Reload na mesma aba nem chega aqui — o `state` do react-router vence. */}
      <div style={{ marginBottom: "0.5rem" }}>
        <CopyText label="permalink" value={permalink} />
      </div>

      <p style={{ color: "#475569", marginTop: 0, fontSize: "0.85rem" }}>
        category {show(intent.category)} · keywords {intent.keywords.join(", ") || "n/a"}
      </p>
      <p style={{ color: "#475569", marginTop: 0, fontSize: "0.85rem" }}>
        catalog snapshot {show(data.catalog_snapshot)} · source {data.source}
      </p>

      {data.degraded ? (
        <p
          role="status"
          style={{ border: "1px solid #fbbf24", background: "#fffbeb", padding: "0.5rem" }}
        >
          Degraded results ({data.degraded_reason ?? "unknown"}): the language model is
          unavailable, so the intent came from the keyword fallback.
        </p>
      ) : null}

      {recommendation ? (
        <p style={{ borderLeft: "3px solid #1d4ed8", paddingLeft: "0.75rem" }}>
          {recommendation.text}
        </p>
      ) : null}

      {results.length === 0 ? (
        <EmptyState />
      ) : (
        <ol style={{ listStyle: "none", padding: 0, margin: "1rem 0 0" }}>
          {results.map((item) => (
            <li
              key={item.skill.skill_id}
              style={{
                border: "1px solid #e2e8f0",
                borderRadius: 8,
                padding: "0.75rem",
                marginBottom: "0.75rem",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem" }}>
                <Link
                  to={`/skills/${item.skill.skill_id}`}
                  style={{ color: "#1d4ed8", fontWeight: 600, textDecoration: "none" }}
                >
                  {item.rank}. {item.skill.name}
                </Link>
                <span style={{ fontVariantNumeric: "tabular-nums" }}>{item.score.toFixed(2)}</span>
              </div>
              <p style={{ margin: "0.35rem 0 0" }}>{item.explanation}</p>
              <Meta item={item} />
              {item.flags.length > 0 ? (
                <p style={{ margin: "0.35rem 0 0", fontSize: "0.8rem", color: "#b45309" }}>
                  flags: {item.flags.join(", ")}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      )}

      {warnings.length > 0 ? (
        <ul style={{ color: "#475569", fontSize: "0.8rem" }}>
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
