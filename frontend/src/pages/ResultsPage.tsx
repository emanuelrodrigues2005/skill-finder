import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";

import { ApiError, loadMockSearch } from "../api";
import { EmptyState, ErrorState, LoadingState } from "../components/States";
import type { ResultItem, SearchResponse } from "../types";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; data: SearchResponse }
  | { status: "error"; message: string; requestId: string | null };

interface LocationState {
  query?: string;
  category?: string | null;
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
  const typed = (location.state ?? {}) as LocationState;
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    // TODO(F2.6): trocar loadMockSearch() por searchSkills(query, category).
    loadMockSearch()
      .then((data) => {
        if (!cancelled) {
          setState({ status: "ready", data });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            message: error instanceof Error ? error.message : "could not load results",
            requestId: error instanceof ApiError ? error.requestId : null,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [typed.query, typed.category]);

  if (state.status === "loading") {
    return <LoadingState label="Searching…" />;
  }

  if (state.status === "error") {
    return (
      <ErrorState
        message={state.message}
        requestId={state.requestId}
        onRetry={() => setState({ status: "loading" })}
      />
    );
  }

  const { results, data, recommendation, warnings } = state.data;
  if (results.length === 0) {
    return <EmptyState />;
  }

  return (
    <section>
      <h2 style={{ fontSize: "1.1rem" }}>Results</h2>
      {typed.query ? <p style={{ color: "#475569", marginTop: 0 }}>“{typed.query}”</p> : null}
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
