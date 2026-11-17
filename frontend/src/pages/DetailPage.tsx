import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Link, useParams } from "react-router-dom";

import { ApiError, getSkill } from "../api";
import { EmptyState, ErrorState, LoadingState } from "../components/States";
import type { SkillDetail } from "../types";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; data: SkillDetail }
  | { status: "error"; message: string; requestId: string | null };

function show(value: string | number | null): string {
  return value === null ? "n/a" : String(value);
}

export default function DetailPage() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    getSkill(id ?? "")
      .then((response) => {
        if (!cancelled) {
          setState({ status: "ready", data: response.data });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            message: error instanceof Error ? error.message : "could not load this skill",
            requestId: error instanceof ApiError ? error.requestId : null,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (state.status === "loading") {
    return <LoadingState label="Loading skill…" />;
  }

  if (state.status === "error") {
    return <ErrorState message={state.message} requestId={state.requestId} />;
  }

  const skill = state.data;

  return (
    <section>
      <p style={{ marginTop: 0 }}>
        <Link to="/results" style={{ color: "#1d4ed8" }}>
          ← back to results
        </Link>
      </p>
      <h2 style={{ fontSize: "1.1rem", margin: "0 0 0.5rem" }}>{skill.name}</h2>
      {skill.summary === null ? null : <p style={{ marginTop: 0 }}>{skill.summary}</p>}

      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "max-content 1fr",
          gap: "0.25rem 1rem",
          margin: "1rem 0",
          fontSize: "0.95rem",
        }}
      >
        <dt style={{ fontWeight: 600 }}>Category</dt>
        <dd style={{ margin: 0 }}>{show(skill.category)}</dd>
        <dt style={{ fontWeight: 600 }}>Stars</dt>
        <dd style={{ margin: 0 }}>{show(skill.stars)}</dd>
        <dt style={{ fontWeight: 600 }}>Installs</dt>
        <dd style={{ margin: 0 }}>{show(skill.installs)}</dd>
        <dt style={{ fontWeight: 600 }}>Vulnerabilities</dt>
        <dd style={{ margin: 0 }}>{show(skill.vulnerability_count)}</dd>
        <dt style={{ fontWeight: 600 }}>Security</dt>
        <dd style={{ margin: 0 }}>{show(skill.security_status)}</dd>
        <dt style={{ fontWeight: 600 }}>Repository</dt>
        <dd style={{ margin: 0 }}>{show(skill.repo_url)}</dd>
      </dl>

      <h3 style={{ fontSize: "1rem" }}>SKILL.md (excerpt)</h3>
      {skill.skill_md_excerpt === null ? (
        <EmptyState message="n/a — this skill has no SKILL.md available." />
      ) : (
        <div style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "0.75rem" }}>
          {/* Sem rehype-raw: HTML no markdown nunca é interpretado. */}
          <ReactMarkdown
            skipHtml
            components={{
              a: ({ children, href }) => (
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {children}
                </a>
              ),
            }}
          >
            {skill.skill_md_excerpt}
          </ReactMarkdown>
        </div>
      )}
    </section>
  );
}
