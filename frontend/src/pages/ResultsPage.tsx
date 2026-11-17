import { useEffect, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";

import { ApiError, describeApiError, getSearch } from "../api";
import { CopyText } from "../components/CopyText";
import { EmptyState, ErrorState, LoadingState } from "../components/States";
import type {
  DegradedReason,
  EvidenceCompleteness,
  Recommendation,
  ResultItem,
  ScoreBreakdown,
  SearchData,
  SearchResponse,
} from "../types";

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: SearchResponse }
  | {
      status: "error";
      message: string;
      code: string | null;
      /** HTTP status da falha (`0` = sem resposta). Um 410 sem envelope também é expirado. */
      httpStatus: number | null;
      requestId: string | null;
    };

/** O que a tela de busca entrega na navegação: a resposta já pronta, sem segundo `POST`. */
interface LocationState {
  response?: SearchResponse;
}

/** Um `null` do contrato vira `n/a` na tela — nunca `0` nem string vazia (AGENTS.md, regra 3). */
function show(value: string | number | null): string {
  return value === null ? "n/a" : String(value);
}

/** Casas decimais só na apresentação: o número exibido é o que a API mandou. */
function decimals(value: number, digits: number): string {
  return value.toFixed(digits);
}

/**
 * `age_seconds` → horas, para a faixa de catálogo desatualizado (AC da #26). É divisão e
 * formatação: nenhum arredondamento feito à mão — a ordem e os escores continuam sendo da API.
 */
function ageInHours(ageSeconds: number): string {
  return decimals(ageSeconds / 3600, 1);
}

interface EvidenceBadge {
  label: string;
  detail: string;
  tone: "complete" | "partial";
}

/**
 * Selo de `evidence_completeness` (AC3). Derivado **apenas** dos dois campos do contrato:
 * sem campo faltando e sem penalidade a evidência está completa; qualquer lacuna vira
 * `partial`, mostrando quantos campos faltam e o fator de confiança que o ranking aplicou.
 */
function evidenceBadge(evidence: EvidenceCompleteness): EvidenceBadge {
  const missing = evidence.missing_fields;
  const confidence = decimals(evidence.penalty_factor, 2);
  if (missing === 0 && evidence.penalty_factor === 1) {
    return { label: "evidence complete", detail: "no missing catalog fields", tone: "complete" };
  }
  if (missing === 0) {
    return {
      label: "partial evidence",
      detail: `no missing fields · confidence ×${confidence}`,
      tone: "partial",
    };
  }
  return {
    label: "partial evidence",
    detail: `${missing} missing field${missing === 1 ? "" : "s"} · confidence ×${confidence}`,
    tone: "partial",
  };
}

/** Os três fatores normalizados do `score_breakdown`, exibidos como vieram — nunca refeitos. */
function factorLine(breakdown: ScoreBreakdown): string {
  return [
    `stars ${decimals(breakdown.stars, 2)}`,
    `installs ${decimals(breakdown.installs, 2)}`,
    `vulnerabilities ${decimals(breakdown.vulnerabilities, 2)}`,
  ].join(" · ");
}

/**
 * 1–3 *bullets* de razão por item (AC4), todos lidos do contrato: a explicação que veio no
 * item, os fatores do `score_breakdown` e, na terceira posição, a ressalva (`caveats`) ou a
 * lacuna de evidência. O corte é posicional; a lista de entrada não é reordenada.
 */
function reasonsFor(item: ResultItem): string[] {
  const explanation = item.explanation.trim();
  const bullets: string[] = [
    explanation === "" ? "no explanation was returned for this item" : explanation,
  ];
  bullets.push(`score factors — ${factorLine(item.score_breakdown)}`);
  const caveat = item.caveats?.trim() ?? "";
  if (caveat !== "") {
    bullets.push(`caveat: ${caveat}`);
  } else if (item.evidence_completeness.missing_fields > 0) {
    bullets.push(
      `evidence gap — ${item.evidence_completeness.missing_fields} catalog field(s) missing`,
    );
  }
  return bullets.slice(0, 3);
}

/**
 * Motivo da degradação → frase de interface (inglês: AGENTS.md, regra 6). O `Record` completo
 * força uma frase por motivo do enum; `degradedHeadline` cobre o motivo que chegue fora dele.
 */
const DEGRADED_HEADLINE: Readonly<Record<DegradedReason, string>> = {
  source_stale: "The catalog snapshot is stale",
  llm_unavailable: "The language model is unavailable — the intent came from the keyword fallback",
};

/** Título da faixa: motivo desconhecido (contrato à frente do bundle) nunca deixa o texto vazio. */
function degradedHeadline(reason: string | null): string {
  const headlines: Readonly<Record<string, string | undefined>> = DEGRADED_HEADLINE;
  return (reason === null ? undefined : headlines[reason]) ?? "Degraded results";
}

function Meta({ item }: { item: ResultItem }) {
  const { skill } = item;
  return (
    <p style={{ margin: "0.35rem 0 0", fontSize: "0.8rem", color: "#475569" }}>
      category {show(skill.category)} · stars {show(skill.stars)} · installs{" "}
      {show(skill.installs)} · vulns {show(skill.vulnerability_count)} · security{" "}
      {skill.security_status}
      {skill.skill_md_present ? "" : " · SKILL.md n/a"}
    </p>
  );
}

/**
 * Faixa de degradação (AC5): mostra o `degraded_reason` e, quando o catálogo está velho, a
 * idade em horas derivada de `age_seconds`. Sem motivo, a faixa ainda aparece — lista sem
 * explicação é o que a regra 7 do AGENTS.md proíbe.
 */
function DegradedBanner({ data }: { data: SearchData }) {
  if (!data.degraded) return null;
  const reason = data.degraded_reason;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        border: "1px solid #fbbf24",
        background: "#fffbeb",
        borderRadius: 8,
        padding: "0.6rem 0.75rem",
        margin: "0 0 1rem",
      }}
    >
      <p style={{ margin: 0, fontWeight: 600 }}>{degradedHeadline(reason)}</p>
      <p style={{ margin: "0.35rem 0 0", fontSize: "0.85rem", color: "#92400e" }}>
        degraded_reason: <code>{show(reason)}</code> · catalog snapshot {data.catalog_snapshot}
        {reason === "source_stale"
          ? ` — ${ageInHours(data.age_seconds)} h old (${data.age_seconds} s)`
          : null}
      </p>
    </div>
  );
}

/**
 * A recomendação única (AC6): destacada acima da lista e amarrada ao item que ela cita —
 * `rank` e nome saem de `results`, então a igualdade com `results[0].skill.skill_id` fica
 * visível na tela. Quando o `skill_id` não está na lista, a tela diz isso em vez de sumir.
 */
function RecommendationPanel({
  recommendation,
  results,
}: {
  recommendation: Recommendation;
  results: ResultItem[];
}) {
  const cited = results.find((item) => item.skill.skill_id === recommendation.skill_id) ?? null;
  const topPick = results.length > 0 ? results[0] : null;
  const matchesTopPick = topPick !== null && topPick.skill.skill_id === recommendation.skill_id;
  return (
    <section
      aria-labelledby="recommendation-heading"
      style={{
        border: "1px solid #1d4ed8",
        borderLeft: "4px solid #1d4ed8",
        borderRadius: 8,
        padding: "0.75rem",
        margin: "0 0 1rem",
      }}
    >
      <h3 id="recommendation-heading" style={{ margin: 0, fontSize: "0.95rem" }}>
        Recommendation
      </h3>
      <p style={{ margin: "0.35rem 0 0", fontWeight: 600 }}>
        <Link to={`/skills/${recommendation.skill_id}`} style={{ color: "#1d4ed8" }}>
          {cited === null ? recommendation.skill_id : cited.skill.name}
        </Link>
        {cited === null ? null : ` · #${cited.rank} of ${results.length}`}
      </p>
      <p style={{ margin: "0.35rem 0 0" }}>{recommendation.text}</p>
      <p style={{ margin: "0.5rem 0 0", fontSize: "0.8rem", color: "#475569" }}>
        skill_id <code>{recommendation.skill_id}</code>{" "}
        {matchesTopPick
          ? "— the top-ranked result"
          : `— top-ranked result is ${topPick === null ? "n/a" : topPick.skill.skill_id}`}
      </p>
    </section>
  );
}

const EXAMPLE_QUERIES = ["extract tables from a pdf", "summarise a changelog"] as const;

const actionStyle = { color: "#1d4ed8" } as const;
const actionLineStyle = { margin: "0.35rem 0 0", fontSize: "0.9rem" } as const;

/**
 * Ações do estado vazio (issue #28; `docs/app/01-spec-produto.md` US-07 AC2): as três saídas são
 * remover a categoria, simplificar a descrição e tentar um dos dois exemplos sugeridos.
 *
 * Cada link volta para `/` levando em `location.state` o que a tela de busca deve mudar — sem essa
 * dica, "remover a categoria" e "tentar um exemplo" seriam todos o mesmo link para o formulário.
 * Não é `<ul>`: o estado vazio já é um `role="status"` e a lista de resultados é o único `list`
 * da tela (o teste da #29 afirma exatamente isso).
 */
function EmptyActions() {
  return (
    <div style={{ borderTop: "1px solid #e2e8f0", marginTop: "0.75rem", paddingTop: "0.75rem" }}>
      <p style={{ margin: 0, fontWeight: 600 }}>What you can try</p>
      <p style={actionLineStyle}>
        <Link to="/" state={{ clearCategory: true }} style={actionStyle}>
          Remove the category filter
        </Link>{" "}
        — search every category instead of one
      </p>
      <p style={actionLineStyle}>
        <Link to="/" style={actionStyle}>
          Simplify the description
        </Link>{" "}
        — fewer words usually match more skills
      </p>
      <p style={actionLineStyle}>
        Or try an example:{" "}
        {EXAMPLE_QUERIES.map((query, index) => (
          <span key={query}>
            {index === 0 ? null : " · "}
            <Link to="/" state={{ exampleQuery: query }} style={actionStyle}>
              {query}
            </Link>
          </span>
        ))}
      </p>
    </div>
  );
}

function ResultCard({ item, isRecommended }: { item: ResultItem; isRecommended: boolean }) {
  const badge = evidenceBadge(item.evidence_completeness);
  const badgeTone =
    badge.tone === "complete"
      ? { border: "#16a34a", background: "#f0fdf4", color: "#166534" }
      : { border: "#f59e0b", background: "#fffbeb", color: "#92400e" };
  return (
    <li
      style={{
        border: "1px solid #e2e8f0",
        borderRadius: 8,
        padding: "0.75rem",
        marginBottom: "0.75rem",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem" }}>
        <h3 style={{ margin: 0, fontSize: "1rem" }}>
          <Link
            to={`/skills/${item.skill.skill_id}`}
            style={{ color: "#1d4ed8", fontWeight: 600, textDecoration: "none" }}
          >
            {item.rank}. {item.skill.name}
          </Link>
          {isRecommended ? (
            <span
              style={{
                marginLeft: "0.5rem",
                border: "1px solid #1d4ed8",
                borderRadius: 999,
                padding: "0.05rem 0.45rem",
                fontSize: "0.7rem",
                color: "#1d4ed8",
                verticalAlign: "middle",
              }}
            >
              recommended
            </span>
          ) : null}
        </h3>
        <span style={{ fontVariantNumeric: "tabular-nums", color: "#334155", fontSize: "0.85rem" }}>
          score {decimals(item.score, 4)}
        </span>
      </div>

      <ul style={{ margin: "0.5rem 0 0", paddingLeft: "1.1rem", color: "#1e293b" }}>
        {reasonsFor(item).map((reason, index) => (
          <li key={`${item.rank}-reason-${index}`} style={{ fontSize: "0.9rem" }}>
            {reason}
          </li>
        ))}
      </ul>

      <Meta item={item} />

      {item.flags.length > 0 ? (
        <p style={{ margin: "0.35rem 0 0", fontSize: "0.8rem", color: "#b45309" }}>
          flags: {item.flags.join(", ")}
        </p>
      ) : null}

      <p style={{ margin: "0.5rem 0 0" }}>
        <span
          style={{
            display: "inline-block",
            border: `1px solid ${badgeTone.border}`,
            background: badgeTone.background,
            color: badgeTone.color,
            borderRadius: 999,
            padding: "0.05rem 0.5rem",
            fontSize: "0.75rem",
            fontWeight: 600,
          }}
        >
          {badge.label}
        </span>
        <span style={{ marginLeft: "0.5rem", fontSize: "0.75rem", color: "#475569" }}>
          {badge.detail}
        </span>
      </p>
    </li>
  );
}

export default function ResultsPage() {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const permalinkId = (searchParams.get("search") ?? "").trim();
  // A busca recém-feita chega em `location.state`, que o react-router v6 guarda em `history.state`
  // — e o navegador **restaura** isso no reload da mesma entrada. Por isso o state é só **pintura
  // inicial**, nunca a verdade final: quando há `?search=`, `getSearch` roda sempre, inclusive no
  // F5 (AC7). Aceitar o state como resposta final esconderia do usuário um permalink vencido.
  const stateResponse = (location.state as LocationState | null)?.response ?? null;
  // O state só pinta a tela se for a resposta que o permalink endereça (ou se não há permalink).
  const paintData =
    stateResponse !== null && (permalinkId === "" || stateResponse.request_id === permalinkId)
      ? stateResponse
      : null;
  const [reloadKey, setReloadKey] = useState(0);
  /**
   * Aviso de limite de uso que **convive** com o resultado anterior (US-11 AC2): quando o 429
   * chega, a lista já na tela continua válida e não pode ser substituída por um erro.
   */
  const [rateLimitNotice, setRateLimitNotice] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>(() => {
    if (paintData !== null) return { status: "ready", data: paintData };
    return permalinkId === "" ? { status: "idle" } : { status: "loading" };
  });

  useEffect(() => {
    // Sem `?search=` não existe permalink a revalidar: a resposta da navegação é a única fonte.
    if (permalinkId === "") {
      setState(paintData === null ? { status: "idle" } : { status: "ready", data: paintData });
      return;
    }
    let cancelled = false;
    // O aviso pertence à tentativa que falhou: um reload novo começa sem ele.
    setRateLimitNotice(null);
    // Primeiro frame com o que veio na navegação (sem "Searching…" numa resposta já pronta)…
    if (paintData !== null) {
      setState({ status: "ready", data: paintData });
    } else {
      setState({ status: "loading" });
    }
    // …e então `GET /api/v1/searches/{request_id}`, sempre: o servidor é a verdade final. Um
    // permalink vencido cai na tela de expirado mesmo que o reload tenha restaurado o state.
    getSearch(permalinkId)
      .then((data) => {
        if (!cancelled) setState({ status: "ready", data });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const described = describeApiError(error);
        const answered = error instanceof ApiError ? error : null;
        // 429 no replay: a lista já pintada continua sendo o resultado anterior e fica na tela;
        // o que muda é o aviso acima dela (US-11 AC2). Sem resposta anterior não há o que manter,
        // e aí o caminho é o estado de erro comum.
        if (answered !== null && answered.status === 429 && paintData !== null) {
          setRateLimitNotice(described.message);
          setState({ status: "ready", data: paintData });
          return;
        }
        setState({
          status: "error",
          message: described.message,
          code: described.code,
          httpStatus: answered === null ? null : answered.status,
          requestId: answered === null ? null : answered.requestId,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [permalinkId, paintData, reloadKey]);

  if (state.status === "idle") {
    return (
      <section>
        <EmptyState message="no search yet — describe the skill you need on the search page" />
        <p style={{ margin: "0.75rem 0 0" }}>
          <Link to="/" style={{ color: "#1d4ed8", fontWeight: 600 }}>
            Start a new search
          </Link>
        </p>
      </section>
    );
  }

  if (state.status === "loading") {
    return <LoadingState label="Searching…" />;
  }

  if (state.status === "error") {
    // 410 `HISTORY_EXPIRED` (AC7): o histórico do permalink venceu. Repetir a chamada não
    // resolve — a saída é refazer a busca, então aqui não aparece o botão "Try again". O `status`
    // entra na decisão porque um 410 **sem envelope** chega com `code: "INTERNAL"`.
    if (state.code === "HISTORY_EXPIRED" || state.httpStatus === 410) {
      return (
        <section>
          <h2 style={{ fontSize: "1.1rem" }}>This search has expired</h2>
          <div
            role="alert"
            style={{
              border: "1px solid #fbbf24",
              background: "#fffbeb",
              borderRadius: 8,
              padding: "1rem",
            }}
          >
            <p style={{ margin: 0 }}>{state.message}</p>
            <p style={{ margin: "0.5rem 0 0", color: "#92400e" }}>
              This permalink is past the history window (code <code>HISTORY_EXPIRED</code>), so
              the stored response can no longer be replayed. A new search rebuilds the ranking
              from the current catalog.
            </p>
            {state.requestId ? (
              <div style={{ marginTop: "0.5rem" }}>
                <CopyText label="request_id" value={state.requestId} />
              </div>
            ) : null}
            <p style={{ margin: "0.75rem 0 0" }}>
              <Link to="/" style={{ color: "#1d4ed8", fontWeight: 600 }}>
                Start a new search
              </Link>
            </p>
          </div>
        </section>
      );
    }
    return (
      <ErrorState
        message={state.message}
        code={state.code}
        requestId={state.requestId}
        onRetry={() => setReloadKey((key) => key + 1)}
      />
    );
  }

  const { request_id, results, data, intent, llm, recommendation, warnings } = state.data;
  const permalink = `${window.location.origin}/results?search=${encodeURIComponent(request_id)}`;
  // `results` é renderizado na ordem recebida: nenhum reordenamento no navegador (regra 1).
  const recommendedId = recommendation?.skill_id ?? null;

  return (
    <section aria-labelledby="results-heading">
      <h2 id="results-heading" style={{ fontSize: "1.1rem" }}>
        Results
      </h2>

      {/* Permalink estável: endereçado pelo `request_id`, a mesma resposta em aba nova ou ao
          compartilhar. O reload da mesma aba revalida com `GET /searches/{id}` e, se o histórico
          venceu, mostra a tela de expirado em vez do state restaurado. */}
      <div style={{ marginBottom: "0.5rem" }}>
        <CopyText label="permalink" value={permalink} />
      </div>

      <p style={{ color: "#475569", margin: "0 0 0.25rem", fontSize: "0.85rem" }}>
        category {show(intent.category)} · keywords {intent.keywords.join(", ") || "n/a"} ·
        confidence {decimals(intent.confidence, 2)}
      </p>
      <p style={{ color: "#475569", margin: "0 0 0.75rem", fontSize: "0.85rem" }}>
        catalog snapshot {data.catalog_snapshot} · source {show(data.source)} · llm {llm.status}
        {llm.cached ? " (cached)" : ""} · model {show(llm.model)}
      </p>

      <DegradedBanner data={data} />

      {/* Limite de uso: o aviso entra acima da lista e não apaga o resultado anterior (US-11). */}
      {rateLimitNotice === null ? null : (
        <div
          role="alert"
          style={{
            border: "1px solid #fbbf24",
            background: "#fffbeb",
            borderRadius: 8,
            padding: "0.75rem",
            margin: "0 0 1rem",
          }}
        >
          <p style={{ margin: 0, fontWeight: 600 }}>{rateLimitNotice}</p>
          <p style={{ margin: "0.35rem 0 0", fontSize: "0.85rem", color: "#92400e" }}>
            code: <code>RATE_LIMITED</code> — the results below are the previous answer, still
            valid.
          </p>
        </div>
      )}

      {recommendation === null ? null : (
        <RecommendationPanel recommendation={recommendation} results={results} />
      )}

      {results.length === 0 ? (
        <div>
          <EmptyState
            hint={
              data.degraded
                ? "the answer is degraded — see the banner above for the reason"
                : undefined
            }
          />
          <EmptyActions />
        </div>
      ) : (
        // `aria-live` na região de resultados (§6.6): a troca de lista por reload/retry é
        // anunciada. `role="list"` preserva o `<ol>` como lista apesar do `list-style: none`.
        <ol
          role="list"
          aria-live="polite"
          aria-labelledby="results-heading"
          style={{ listStyle: "none", padding: 0, margin: "1rem 0 0" }}
        >
          {results.map((item) => (
            <ResultCard
              key={`${item.rank}-${item.skill.skill_id}`}
              item={item}
              isRecommended={recommendedId === item.skill.skill_id}
            />
          ))}
        </ol>
      )}

      {warnings.length > 0 ? (
        <section aria-labelledby="warnings-heading" style={{ marginTop: "1rem" }}>
          <h3 id="warnings-heading" style={{ margin: 0, fontSize: "0.95rem" }}>
            Warnings
          </h3>
          <ul style={{ color: "#475569", fontSize: "0.8rem", margin: "0.35rem 0 0" }}>
            {warnings.map((warning, index) => (
              <li key={`${index}-${warning}`}>{warning}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}
