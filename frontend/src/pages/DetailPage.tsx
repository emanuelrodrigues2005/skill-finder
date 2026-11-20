import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import { ApiError, describeApiError, getSkill } from "../api";
import { CopyText } from "../components/CopyText";
import { EmptyState, ErrorState, LoadingState } from "../components/States";
import type { SkillDetail } from "../types";
import { STR } from "../ui/strings";
import { color, font, radius, space } from "../ui/tokens";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; data: SkillDetail }
  | { status: "error"; message: string; code: string | null; requestId: string | null };

/** Regra 3 do `AGENTS.md`: dado ausente é `null`, jamais zero. */
const NA = STR.common.na;

/**
 * `null` (do contrato) vira `n/a`. `0` que o servidor mandar é dado real e aparece como `0`; esta
 * tela nunca inventa zero para métrica ausente.
 */
function show(value: string | number | null | undefined): string {
  return value === null || value === undefined ? NA : String(value);
}

/**
 * Data legível a partir do RFC 3339 do contrato (`data_snapshot`). O contrato guarda o
 * instante completo porque ele vem do `ingest_run`; a tela responde "de quando é o dado".
 * Valor que não começa com `YYYY-MM-DD` cai em `n/a` em vez de virar texto quebrado.
 */
function showDate(value: string | null | undefined): string {
  if (typeof value !== "string") return NA;
  const date = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : NA;
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
      style={{ color: color.link, overflowWrap: "anywhere" }}
    >
      {value}
    </a>
  );
}

/** `404 NOT_FOUND`: a skill não existe — copy própria, `request_id` preservado para suporte. */
function NotFoundState({ requestId }: { requestId: string | null }) {
  return (
    <div
      role="alert"
      style={{ border: `1px solid ${color.danger}`, padding: space.lg, borderRadius: radius.md }}
    >
      <p style={{ margin: 0, fontWeight: font.weight.strong }}>{STR.detail.notFound.title}</p>
      <p style={{ margin: `${space.sm} 0 0` }}>{STR.detail.notFound.detail}</p>
      {requestId ? (
        <div style={{ marginTop: space.sm }}>
          <CopyText label={STR.common.requestIdLabel} value={requestId} />
        </div>
      ) : null}
      <p style={{ margin: `${space.md} 0 0` }}>
        <Link to="/" style={{ color: color.link }}>
          {STR.common.newSearch}
        </Link>
      </p>
    </div>
  );
}

export default function DetailPage() {
  const { id } = useParams<{ id: string }>();

  // A busca que trouxe o usuario ate aqui. Vem no `?search=` do link da skill
  // (`/skills/<id>?search=<request_id>`), entao sobrevive a reload e a link
  // compartilhado — diferente de guardar em memoria, que sumia no "voltar" e
  // deixava a tela de resultados vazia ("nenhuma busca ainda").
  const [searchParams] = useSearchParams();
  const searchId = (searchParams.get("search") ?? "").trim();
  const backToResults = searchId === "" ? "/results" : `/results?search=${encodeURIComponent(searchId)}`;
  const skillId = (id ?? "").trim();
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    // Sem `:id` não existe detalhe: `GET /api/v1/skills/` seria a listagem, com outra forma.
    if (skillId === "") {
      setState({
        status: "error",
        message: STR.detail.notFound.title,
        code: "NOT_FOUND",
        requestId: null,
      });
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
    return <LoadingState label={STR.detail.loading} />;
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
      <p style={{ marginTop: 0, fontSize: font.size.compact }}>
        <Link to={backToResults} style={{ color: color.link, textDecoration: "none" }}>
          {STR.detail.backToResults}
        </Link>
      </p>

      {/*
        Ficha de medida: título e resumo à esquerda, dados à direita em tabela de duas colunas
        separadas por fio. Em tela estreita o `flexWrap` empilha sem media query — o projeto não
        tem folha de estilo e um breakpoint inline não existe.
      */}
      <div style={{ display: "flex", gap: space.xl, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ flex: "1 1 24rem", minWidth: "18rem" }}>
          <h2
            style={{
              fontSize: font.size.display,
              fontWeight: font.weight.black,
              letterSpacing: font.tracking.tight,
              lineHeight: font.leading.tight,
              margin: `0 0 ${space.sm}`,
            }}
          >
            {skill.name}
          </h2>
          <p style={{ margin: 0, color: color.textBody, fontSize: font.size.lead, maxWidth: "42rem" }}>
            {show(skill.summary)}
          </p>
        </div>

        <dl
          style={{
            flex: "0 1 20rem",
            minWidth: "16rem",
            margin: 0,
            borderTop: `1px solid ${color.hairline}`,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: space.md,
              padding: `${space.xs} 0`,
              borderBottom: `1px solid ${color.hairline}`,
            }}
          >
            <dt style={{ margin: 0, color: color.textMuted, fontSize: font.size.compact }}>
              {STR.detail.fields.category}
            </dt>
            <dd
              style={{
                margin: 0,
                fontFamily: font.family.mono,
                fontVariantNumeric: "tabular-nums",
                fontSize: font.size.compact,
                color: color.textBody,
                textAlign: "right",
              }}
            >
              {show(skill.category)}
            </dd>
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: space.md,
              padding: `${space.xs} 0`,
              borderBottom: `1px solid ${color.hairline}`,
            }}
          >
            <dt style={{ margin: 0, color: color.textMuted, fontSize: font.size.compact }}>
              {STR.detail.fields.stars}
            </dt>
            <dd
              style={{
                margin: 0,
                fontFamily: font.family.mono,
                fontVariantNumeric: "tabular-nums",
                fontSize: font.size.compact,
                color: color.textBody,
                textAlign: "right",
              }}
            >
              {show(skill.stars)}
            </dd>
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: space.md,
              padding: `${space.xs} 0`,
              borderBottom: `1px solid ${color.hairline}`,
            }}
          >
            <dt style={{ margin: 0, color: color.textMuted, fontSize: font.size.compact }}>
              {STR.detail.fields.installs}
            </dt>
            <dd
              style={{
                margin: 0,
                fontFamily: font.family.mono,
                fontVariantNumeric: "tabular-nums",
                fontSize: font.size.compact,
                color: color.textBody,
                textAlign: "right",
              }}
            >
              {show(skill.installs)}
            </dd>
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: space.md,
              padding: `${space.xs} 0`,
              borderBottom: `1px solid ${color.hairline}`,
            }}
          >
            <dt style={{ margin: 0, color: color.textMuted, fontSize: font.size.compact }}>
              {STR.detail.fields.vulnerabilities}
            </dt>
            <dd
              style={{
                margin: 0,
                fontFamily: font.family.mono,
                fontVariantNumeric: "tabular-nums",
                fontSize: font.size.compact,
                color: color.textBody,
                textAlign: "right",
              }}
            >
              {show(skill.vulnerability_count)}
            </dd>
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: space.md,
              padding: `${space.xs} 0`,
              borderBottom: `1px solid ${color.hairline}`,
            }}
          >
            <dt style={{ margin: 0, color: color.textMuted, fontSize: font.size.compact }}>
              {STR.detail.fields.security}
            </dt>
            <dd
              style={{
                margin: 0,
                fontFamily: font.family.mono,
                fontVariantNumeric: "tabular-nums",
                fontSize: font.size.compact,
                color: color.textBody,
                textAlign: "right",
              }}
            >
              {show(skill.security_status)}
            </dd>
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: space.md,
              padding: `${space.xs} 0`,
              borderBottom: `1px solid ${color.hairline}`,
            }}
          >
            <dt style={{ margin: 0, color: color.textMuted, fontSize: font.size.compact }}>
              {STR.detail.fields.skillMd}
            </dt>
            <dd
              style={{
                margin: 0,
                fontFamily: font.family.mono,
                fontVariantNumeric: "tabular-nums",
                fontSize: font.size.compact,
                color: color.textBody,
                textAlign: "right",
              }}
            >
              {skill.skill_md_present ? STR.detail.present : NA}
            </dd>
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: space.md,
              padding: `${space.xs} 0`,
              borderBottom: `1px solid ${color.hairline}`,
            }}
          >
            <dt style={{ margin: 0, color: color.textMuted, fontSize: font.size.compact }}>
              {STR.detail.fields.snapshotDate}
            </dt>
            <dd
              style={{
                margin: 0,
                fontFamily: font.family.mono,
                fontVariantNumeric: "tabular-nums",
                fontSize: font.size.compact,
                color: color.textBody,
                textAlign: "right",
              }}
              title={skill.data_snapshot ?? undefined}
            >
              {showDate(skill.data_snapshot)}
            </dd>
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: space.md,
              padding: `${space.xs} 0`,
              borderBottom: `1px solid ${color.hairline}`,
            }}
          >
            <dt style={{ margin: 0, color: color.textMuted, fontSize: font.size.compact }}>
              {STR.detail.fields.source}
            </dt>
            <dd style={{ margin: 0, fontSize: font.size.compact, textAlign: "right" }}>
              <ExternalValue value={skill.source_url} />
            </dd>
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: space.md,
              padding: `${space.xs} 0`,
              borderBottom: `1px solid ${color.hairline}`,
            }}
          >
            <dt style={{ margin: 0, color: color.textMuted, fontSize: font.size.compact }}>
              {STR.detail.fields.repository}
            </dt>
            <dd style={{ margin: 0, fontSize: font.size.compact, textAlign: "right" }}>
              <ExternalValue value={skill.repo_url} />
            </dd>
          </div>
        </dl>
      </div>

      <h3
        style={{
          fontSize: font.size.title,
          fontWeight: font.weight.strong,
          margin: `${space.xl} 0 ${space.sm}`,
        }}
      >
        {STR.detail.skillMdSection}
      </h3>
      {hasExcerpt ? (
        <div
          style={{
            border: `1px solid ${color.hairline}`,
            borderLeft: `3px solid ${color.hairline}`,
            borderRadius: radius.none,
            padding: space.lg,
            background: color.surface,
          }}
        >
          {/*
            Texto puro, não markdown: `openapi.yaml` define `skill_md_excerpt` como "Plain text …
            no raw markdown … Render escaped; never as HTML or markdown". O JSX já escapa o valor,
            então sintaxe de markdown e tag HTML aparecem como caracteres — nada é interpretado e
            nenhum `href` sai daqui.
          */}
          <p
            style={{
              margin: 0,
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              maxWidth: "68ch",
              color: color.textBody,
              fontSize: font.size.compact,
              lineHeight: font.leading.body,
            }}
          >
            {excerpt}
          </p>
        </div>
      ) : (
        <EmptyState message={STR.detail.noDescription} hint={STR.detail.skillMdHint(NA)} />
      )}
    </section>
  );
}
