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
import { STR } from "../ui/strings";
import { color, font, radius, space } from "../ui/tokens";

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
  return value === null ? STR.common.na : String(value);
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
    return {
      label: STR.results.evidence.completeLabel,
      detail: STR.results.evidence.completeDetail,
      tone: "complete",
    };
  }
  if (missing === 0) {
    return {
      label: STR.results.evidence.partialLabel,
      detail: STR.results.evidence.partialNoMissing(confidence),
      tone: "partial",
    };
  }
  return {
    label: STR.results.evidence.partialLabel,
    detail: STR.results.evidence.partialMissing(missing, confidence),
    tone: "partial",
  };
}

/** Os três fatores normalizados do `score_breakdown`, exibidos como vieram — nunca refeitos. */
function factorLine(breakdown: ScoreBreakdown): string {
  return STR.results.card.factors(
    decimals(breakdown.stars, 2),
    decimals(breakdown.installs, 2),
    decimals(breakdown.vulnerabilities, 2),
  );
}

/**
 * 1–3 *bullets* de razão por item (AC4), todos lidos do contrato: a explicação que veio no
 * item, os fatores do `score_breakdown` e, na terceira posição, a ressalva (`caveats`) ou a
 * lacuna de evidência. O corte é posicional; a lista de entrada não é reordenada.
 */
function reasonsFor(item: ResultItem): string[] {
  const explanation = item.explanation.trim();
  const bullets: string[] = [
    explanation === "" ? STR.results.card.noExplanation : explanation,
  ];
  bullets.push(`${STR.results.card.factorsPrefix} — ${factorLine(item.score_breakdown)}`);
  const caveat = item.caveats?.trim() ?? "";
  if (caveat !== "") {
    bullets.push(STR.results.card.caveat(caveat));
  } else if (item.evidence_completeness.missing_fields > 0) {
    bullets.push(STR.results.card.evidenceGap(item.evidence_completeness.missing_fields));
  }
  return bullets.slice(0, 3);
}

/**
 * Motivo da degradação → frase de interface (pt-BR: AGENTS.md, regra 6). O `Record` completo
 * força uma frase por motivo do enum; `degradedHeadline` cobre o motivo que chegue fora dele.
 */
const DEGRADED_HEADLINE: Readonly<Record<DegradedReason, string>> = STR.results.degraded.headline;

/** Título da faixa: motivo desconhecido (contrato à frente do bundle) nunca deixa o texto vazio. */
function degradedHeadline(reason: string | null): string {
  const headlines: Readonly<Record<string, string | undefined>> = DEGRADED_HEADLINE;
  return (reason === null ? undefined : headlines[reason]) ?? STR.results.degraded.fallback;
}

function Meta({ item }: { item: ResultItem }) {
  const { skill } = item;
  return (
    <p style={{ margin: "0.35rem 0 0", fontSize: font.size.small, color: color.textMuted }}>
      {STR.results.card.meta(
        show(skill.category),
        show(skill.stars),
        show(skill.installs),
        show(skill.vulnerability_count),
        skill.security_status,
        skill.skill_md_present,
      )}
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
        border: `1px solid ${color.warn}`,
        background: color.warnSurface,
        borderRadius: radius.md,
        padding: `0.6rem ${space.md}`,
        margin: `0 0 ${space.lg}`,
      }}
    >
      <p style={{ margin: 0, fontWeight: font.weight.strong }}>{degradedHeadline(reason)}</p>
      <p style={{ margin: "0.35rem 0 0", fontSize: font.size.compact, color: color.warnText }}>
        {STR.results.degraded.reasonLabel} <code>{show(reason)}</code> ·{" "}
        {STR.results.degraded.snapshotLabel} {data.catalog_snapshot}
        {reason === "source_stale"
          ? STR.results.degraded.ageSuffix(ageInHours(data.age_seconds), data.age_seconds)
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
        border: `1px solid ${color.link}`,
        borderLeft: `4px solid ${color.link}`,
        borderRadius: radius.md,
        padding: space.md,
        margin: `0 0 ${space.lg}`,
      }}
    >
      <h3 id="recommendation-heading" style={{ margin: 0, fontSize: font.size.lead }}>
        {STR.results.recommendation.heading}
      </h3>
      <p style={{ margin: "0.35rem 0 0", fontWeight: font.weight.strong }}>
        <Link to={`/skills/${recommendation.skill_id}`} style={{ color: color.link }}>
          {cited === null ? recommendation.skill_id : cited.skill.name}
        </Link>
        {cited === null ? null : STR.results.recommendation.rankSuffix(cited.rank, results.length)}
      </p>
      <p style={{ margin: "0.35rem 0 0" }}>{recommendation.text}</p>
      <p style={{ margin: `${space.sm} 0 0`, fontSize: font.size.small, color: color.textMuted }}>
        {STR.results.recommendation.skillIdLabel} <code>{recommendation.skill_id}</code>{" "}
        {matchesTopPick
          ? STR.results.recommendation.isTopPick
          : STR.results.recommendation.isNotTopPick(
              topPick === null ? STR.common.na : topPick.skill.skill_id,
            )}
      </p>
    </section>
  );
}

const EXAMPLE_QUERIES = STR.results.emptyActions.examples;

const actionStyle = { color: color.link } as const;
const actionLineStyle = { margin: "0.35rem 0 0", fontSize: font.size.body } as const;

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
    <div style={{ borderTop: `1px solid ${color.border}`, marginTop: space.md, paddingTop: space.md }}>
      <p style={{ margin: 0, fontWeight: font.weight.strong }}>{STR.results.emptyActions.heading}</p>
      <p style={actionLineStyle}>
        <Link to="/" state={{ clearCategory: true }} style={actionStyle}>
          {STR.results.emptyActions.removeCategory}
        </Link>{" "}
        {STR.results.emptyActions.removeCategoryNote}
      </p>
      <p style={actionLineStyle}>
        <Link to="/" style={actionStyle}>
          {STR.results.emptyActions.simplify}
        </Link>{" "}
        {STR.results.emptyActions.simplifyNote}
      </p>
      <p style={actionLineStyle}>
        {STR.results.emptyActions.examplePrefix}{" "}
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
      ? { border: color.success, background: color.successSurface, color: color.successText }
      : { border: color.warnAccent, background: color.warnSurface, color: color.warnText };
  return (
    <li
      style={{
        border: `1px solid ${color.border}`,
        borderRadius: radius.md,
        padding: space.md,
        marginBottom: space.md,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: space.sm }}>
        <h3 style={{ margin: 0, fontSize: font.size.title }}>
          <Link
            to={`/skills/${item.skill.skill_id}`}
            style={{ color: color.link, fontWeight: font.weight.strong, textDecoration: "none" }}
          >
            {item.rank}. {item.skill.name}
          </Link>
          {isRecommended ? (
            <span
              style={{
                marginLeft: space.sm,
                border: `1px solid ${color.link}`,
                borderRadius: radius.pill,
                padding: "0.05rem 0.45rem",
                fontSize: font.size.caption,
                color: color.link,
                verticalAlign: "middle",
              }}
            >
              {STR.results.card.recommendedBadge}
            </span>
          ) : null}
        </h3>
        <span
          style={{ fontVariantNumeric: "tabular-nums", color: color.textSubtle, fontSize: font.size.compact }}
        >
          {STR.results.card.score(decimals(item.score, 4))}
        </span>
      </div>

      <ul style={{ margin: `${space.sm} 0 0`, paddingLeft: "1.1rem", color: color.textBody }}>
        {reasonsFor(item).map((reason, index) => (
          <li key={`${item.rank}-reason-${index}`} style={{ fontSize: font.size.body }}>
            {reason}
          </li>
        ))}
      </ul>

      <Meta item={item} />

      {item.flags.length > 0 ? (
        <p style={{ margin: "0.35rem 0 0", fontSize: font.size.small, color: color.flagText }}>
          {STR.results.card.flags(item.flags.join(", "))}
        </p>
      ) : null}

      <p style={{ margin: `${space.sm} 0 0` }}>
        <span
          style={{
            display: "inline-block",
            border: `1px solid ${badgeTone.border}`,
            background: badgeTone.background,
            color: badgeTone.color,
            borderRadius: radius.pill,
            padding: `0.05rem ${space.sm}`,
            fontSize: font.size.meta,
            fontWeight: font.weight.strong,
          }}
        >
          {badge.label}
        </span>
        <span style={{ marginLeft: space.sm, fontSize: font.size.meta, color: color.textMuted }}>
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
    // Primeiro frame com o que veio na navegação (sem "Buscando…" numa resposta já pronta)…
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
        <EmptyState message={STR.states.empty.noSearch} />
        <p style={{ margin: `${space.md} 0 0` }}>
          <Link to="/" style={{ color: color.link, fontWeight: font.weight.strong }}>
            {STR.common.newSearch}
          </Link>
        </p>
      </section>
    );
  }

  if (state.status === "loading") {
    return <LoadingState label={STR.states.loading.search} />;
  }

  if (state.status === "error") {
    // 410 `HISTORY_EXPIRED` (AC7): o histórico do permalink venceu. Repetir a chamada não
    // resolve — a saída é refazer a busca, então aqui não aparece o botão de tentar de novo. O
    // `status` entra na decisão porque um 410 **sem envelope** chega com `code: "INTERNAL"`.
    if (state.code === "HISTORY_EXPIRED" || state.httpStatus === 410) {
      return (
        <section>
          <h2 style={{ fontSize: font.size.heading }}>{STR.results.expired.heading}</h2>
          <div
            role="alert"
            style={{
              border: `1px solid ${color.warn}`,
              background: color.warnSurface,
              borderRadius: radius.md,
              padding: space.lg,
            }}
          >
            <p style={{ margin: 0 }}>{state.message}</p>
            <p style={{ margin: `${space.sm} 0 0`, color: color.warnText }}>
              {STR.results.expired.detail}
            </p>
            {state.requestId ? (
              <div style={{ marginTop: space.sm }}>
                <CopyText label={STR.common.requestIdLabel} value={state.requestId} />
              </div>
            ) : null}
            <p style={{ margin: `${space.md} 0 0` }}>
              <Link to="/" style={{ color: color.link, fontWeight: font.weight.strong }}>
                {STR.common.newSearch}
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
      <h2 id="results-heading" style={{ fontSize: font.size.heading }}>
        {STR.results.heading}
      </h2>

      {/* Permalink estável: endereçado pelo `request_id`, a mesma resposta em aba nova ou ao
          compartilhar. O reload da mesma aba revalida com `GET /searches/{id}` e, se o histórico
          venceu, mostra a tela de expirado em vez do state restaurado. */}
      <div style={{ marginBottom: space.sm }}>
        <CopyText label={STR.results.permalinkLabel} value={permalink} />
      </div>

      <p style={{ color: color.textMuted, margin: `0 0 ${space.xs}`, fontSize: font.size.compact }}>
        {STR.results.intentLine(
          show(intent.category),
          intent.keywords.join(", ") || STR.common.na,
          decimals(intent.confidence, 2),
        )}
      </p>
      <p style={{ color: color.textMuted, margin: `0 0 ${space.md}`, fontSize: font.size.compact }}>
        {STR.results.snapshotLine(
          data.catalog_snapshot,
          show(data.source),
          llm.status,
          llm.cached,
          show(llm.model),
        )}
      </p>

      <DegradedBanner data={data} />

      {/* Limite de uso: o aviso entra acima da lista e não apaga o resultado anterior (US-11). */}
      {rateLimitNotice === null ? null : (
        <div
          role="alert"
          style={{
            border: `1px solid ${color.warn}`,
            background: color.warnSurface,
            borderRadius: radius.md,
            padding: space.md,
            margin: `0 0 ${space.lg}`,
          }}
        >
          <p style={{ margin: 0, fontWeight: font.weight.strong }}>{rateLimitNotice}</p>
          <p style={{ margin: "0.35rem 0 0", fontSize: font.size.compact, color: color.warnText }}>
            {STR.results.rateLimit.codeLabel} <code>RATE_LIMITED</code>{" "}
            {STR.results.rateLimit.detail}
          </p>
        </div>
      )}

      {recommendation === null ? null : (
        <RecommendationPanel recommendation={recommendation} results={results} />
      )}

      {results.length === 0 ? (
        <div>
          <EmptyState hint={data.degraded ? STR.results.empty.degradedHint : undefined} />
          <EmptyActions />
        </div>
      ) : (
        // `aria-live` na região de resultados (§6.6): a troca de lista por reload/retry é
        // anunciada. `role="list"` preserva o `<ol>` como lista apesar do `list-style: none`.
        <ol
          role="list"
          aria-live="polite"
          aria-labelledby="results-heading"
          style={{ listStyle: "none", padding: 0, margin: `${space.lg} 0 0` }}
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
        <section aria-labelledby="warnings-heading" style={{ marginTop: space.lg }}>
          <h3 id="warnings-heading" style={{ margin: 0, fontSize: font.size.lead }}>
            {STR.results.warnings.heading}
          </h3>
          <ul style={{ color: color.textMuted, fontSize: font.size.small, margin: "0.35rem 0 0" }}>
            {warnings.map((warning, index) => (
              <li key={`${index}-${warning}`}>{warning}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}
