import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { ApiError, describeApiError, getSkill } from "../api";
import { CopyText } from "../components/CopyText";
import { EmptyState, ErrorState, LoadingState } from "../components/States";
import type { SkillDetail } from "../types";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; data: SkillDetail }
  | { status: "error"; message: string; code: string | null; requestId: string | null };

/** Regra 3 do `AGENTS.md`: dado ausente é `null`, jamais zero. */
const NA = "n/a";

/** Texto fixado pelo AC do detalhe quando não existe `SKILL.md` para mostrar. */
const NO_DESCRIPTION = "No full description available for this skill";

/**
 * `null` (do contrato) vira `n/a`. `0` que o servidor mandar é dado real e aparece como `0`; esta
 * tela nunca inventa zero para métrica ausente.
 */
function show(value: string | number | null | undefined): string {
  return value === null || value === undefined ? NA : String(value);
}

/**
 * URL externa: só sai clicável com esquema `http`/`https`, decidido no esquema **parseado**.
 *
 * `javascript:` é URI sintaticamente válida (RFC 3986), então procurar `http` no começo do texto
 * cru não é checagem suficiente. `new URL` normaliza (espaço à esquerda, maiúsculas, entidades) e
 * o protocolo é comparado exatamente; o que sobra de host vazio ou de esquema exótico vira texto.
 */
function externalHttpUrl(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const candidate = value.trim();
  if (candidate === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.hostname === "" ? null : parsed.href;
}

/** Link externo com `rel` de segurança; valor não-`http(s)` aparece como texto, sem `href`. */
function ExternalValue({ value }: { value: string | null }) {
    // `null` é a ausência prevista no contrato; `""` não deveria acontecer, mas
    // renderizaria um `<dd>` em branco — a tela sem explicação da regra 7.
    if (value === null || value.trim() === "") return <>{NA}</>;
  const href = externalHttpUrl(value);
  if (href === null) return <>{value}</>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{ color: "#1d4ed8", overflowWrap: "anywhere" }}
    >
      {value}
    </a>
  );
}

/** `404 NOT_FOUND`: a skill não existe — copy própria, `request_id` preservado para suporte. */
function NotFoundState({ requestId }: { requestId: string | null }) {
  return (
    <div role="alert" style={{ border: "1px solid #f87171", padding: "1rem", borderRadius: 8 }}>
      <p style={{ margin: 0, fontWeight: 600 }}>Skill not found</p>
      <p style={{ margin: "0.5rem 0 0" }}>
        This skill does not exist in the catalog, or its id is malformed.
      </p>
      {requestId ? (
        <div style={{ marginTop: "0.5rem" }}>
          <CopyText label="request_id" value={requestId} />
        </div>
      ) : null}
      <p style={{ margin: "0.75rem 0 0" }}>
        <Link to="/" style={{ color: "#1d4ed8" }}>
          Start a new search
        </Link>
      </p>
    </div>
  );
}

export default function DetailPage() {
  const { id } = useParams<{ id: string }>();
  const skillId = (id ?? "").trim();
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    // Sem `:id` não existe detalhe: `GET /api/v1/skills/` seria a listagem, com outra forma.
    if (skillId === "") {
      setState({ status: "error", message: "Skill not found", code: "NOT_FOUND", requestId: null });
      return () => {
        cancelled = true;
      };
    }
    setState({ status: "loading" });
    getSkill(skillId)
      .then((response) => {
        if (!cancelled) {
          setState({ status: "ready", data: response.data });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          // `describeApiError` traduz por código: `TypeError`/`Failed to fetch` nunca viram interface.
          const described = describeApiError(error);
          setState({
            status: "error",
            message: described.message,
            code: described.code,
            requestId: error instanceof ApiError ? error.requestId : null,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [skillId]);

  if (state.status === "loading") {
    return <LoadingState label="Loading skill…" />;
  }

  if (state.status === "error") {
    // Só o 404 tem copy de "não existe"; 422 e 500 caem no estado de erro comum.
    if (state.code === "NOT_FOUND") {
      return <NotFoundState requestId={state.requestId} />;
    }
    return <ErrorState message={state.message} code={state.code} requestId={state.requestId} />;
  }

  const skill = state.data;
  const excerpt = skill.skill_md_excerpt;
  // A seção é derivada do campo que a tela EXIBE (`skill_md_excerpt`), não da
  // flag: o backend produz os dois por caminhos diferentes (`skill_md_present`
  // vem de coluna própria) e `toPlainText` pode legitimamente devolver "" —
  // um SKILL.md só de bloco de código/HTML vira texto vazio. Acoplar os dois
  // escondia trecho existente e, com trecho vazio, deixava uma caixa com borda
  // e nada dentro (a "tela em branco sem explicação" da regra 7).
  const hasExcerpt = excerpt !== null && excerpt.trim() !== "";

  return (
    <section>
      <p style={{ marginTop: 0 }}>
        <Link to="/results" style={{ color: "#1d4ed8" }}>
          ← back to results
        </Link>
      </p>
      <h2 style={{ fontSize: "1.1rem", margin: "0 0 0.5rem" }}>{skill.name}</h2>
      <p style={{ marginTop: 0 }}>{show(skill.summary)}</p>

      {/*
        Sem data de referência do dado: `components.schemas.SkillDetail` não tem `fetched_at`,
        `catalog_snapshot`, `first_seen_at` nem `last_seen_at` — só a resposta de busca publica
        `data.catalog_snapshot`. Campo inexistente não é inventado aqui.
      */}
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
        <dt style={{ fontWeight: 600 }}>Source</dt>
        <dd style={{ margin: 0 }}>
          <ExternalValue value={skill.source_url} />
        </dd>
        <dt style={{ fontWeight: 600 }}>Repository</dt>
        <dd style={{ margin: 0 }}>
          <ExternalValue value={skill.repo_url} />
        </dd>
        <dt style={{ fontWeight: 600 }}>SKILL.md</dt>
        <dd style={{ margin: 0 }}>{skill.skill_md_present ? "present" : NA}</dd>
      </dl>

      <h3 style={{ fontSize: "1rem" }}>SKILL.md</h3>
      {hasExcerpt ? (
        <div style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "0.75rem" }}>
          {/*
            Texto puro, não markdown: `openapi.yaml:1221-1227` define `skill_md_excerpt` como
            "Plain text … no raw markdown … Render escaped; never as HTML or markdown". O JSX já
            escapa o valor, então sintaxe de markdown e tag HTML aparecem como caracteres — nada
            é interpretado e nenhum `href` sai daqui.
          */}
          <p style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{excerpt}</p>
        </div>
      ) : (
        <EmptyState message={NO_DESCRIPTION} hint={`SKILL.md: ${NA}`} />
      )}
    </section>
  );
}
