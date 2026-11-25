/**
 * A rota da transcrição: `/results?search=<request_id>`.
 *
 * A página é a **máquina de estados** e a moldura; a conversa em si é a folha
 * (`components/Transcript`), que recebe a resposta e o `?search=` por prop e não conhece a rota.
 *
 * Estados: `idle` (sem `?search=`), `loading`, `ready`, `error`, `410` (histórico vencido) e
 * `429` com resposta anterior — o caso em que a lista já na tela continua válida e o que muda é
 * só o aviso acima dela (US-11 AC2).
 *
 * O anúncio acessível é **uma** linha de status, montada desde o carregamento e nunca desmontada
 * (WCAG 4.1.3): "Pensando…" enquanto a busca está a caminho, "N skills encontradas" quando ela
 * chega. A lista de resultados não é região viva — antes era, e uma busca nova anunciava o
 * conteúdo inteiro de novo.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";

import { ApiError, describeApiError, getSearch } from "../api";
import { CopyText } from "../components/CopyText";
import { EmptyState, ErrorState } from "../components/States";
import { Transcript, withQuery } from "../components/Transcript";
import type { SearchResponse } from "../types";
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

/**
 * O que a tela de busca entrega na navegação: a resposta já pronta (sem segundo `POST`) e o
 * texto digitado, que a resposta pode não carregar ainda.
 */
interface LocationState {
  response?: SearchResponse;
  /** Campo do contrato que está chegando (`response.query`); aqui é o fallback da navegação. */
  query?: string;
}

const STATUS_STYLE = {
  display: "flex",
  alignItems: "center",
  gap: space.sm,
  margin: `0 0 ${space.lg}`,
  color: color.textMuted,
  fontFamily: font.family.mono,
  fontSize: font.size.compact,
} as const;

/** Texto da linha de status: é a única região viva da tela. */
function statusText(state: LoadState): string {
  if (state.status === "loading") return STR.transcript.status.thinking;
  if (state.status === "ready") return STR.transcript.status.found(state.data.results.length);
  // `idle` e os erros têm o próprio anúncio (`EmptyState`, `ErrorState`, `role="alert"`): a
  // linha continua montada, vazia — uma região viva precisa existir antes da mutação.
  return "";
}

function stateQuery(location: LocationState | null): string | null {
  const text = location?.query;
  return typeof text === "string" && text.trim() !== "" ? text : null;
}

export default function ResultsPage() {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const searchId = (searchParams.get("search") ?? "").trim();
  const carriedState = (location.state as LocationState | null) ?? null;
  // A busca recém-feita chega em `location.state`, que o react-router v6 guarda em `history.state`
  // — e o navegador **restaura** isso no reload da mesma entrada. Por isso o state é só **pintura
  // inicial**, nunca a verdade final: quando há `?search=`, `getSearch` roda sempre, inclusive no
  // F5. Aceitar o state como resposta final esconderia do usuário um permalink vencido.
  const stateResponse = carriedState?.response ?? null;
  // O state só pinta a tela se for a resposta que o permalink endereça (ou se não há permalink).
  const paintData =
    stateResponse !== null && (searchId === "" || stateResponse.request_id === searchId)
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
    return searchId === "" ? { status: "idle" } : { status: "loading" };
  });

  useEffect(() => {
    // Sem `?search=` não existe permalink a revalidar: a resposta da navegação é a única fonte.
    if (searchId === "") {
      setState(paintData === null ? { status: "idle" } : { status: "ready", data: paintData });
      return;
    }
    let cancelled = false;
    // O aviso pertence à tentativa que falhou: um reload novo começa sem ele.
    setRateLimitNotice(null);
    // Primeiro frame com o que veio na navegação (sem "Pensando…" numa resposta já pronta)…
    if (paintData !== null) {
      setState({ status: "ready", data: paintData });
    } else {
      setState({ status: "loading" });
    }
    // …e então `GET /api/v1/searches/{request_id}`, sempre: o servidor é a verdade final. Um
    // permalink vencido cai na tela de expirado mesmo que o reload tenha restaurado o state.
    getSearch(searchId)
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
  }, [searchId, paintData, reloadKey]);

  let body: ReactNode = null;

  if (state.status === "idle") {
    body = (
      <div>
        <EmptyState message={STR.states.empty.noSearch} />
        <p style={{ margin: `${space.md} 0 0` }}>
          <Link to="/" style={{ color: color.link, fontWeight: font.weight.strong }}>
            {STR.common.newSearch}
          </Link>
        </p>
      </div>
    );
  } else if (state.status === "error") {
    // 410 `HISTORY_EXPIRED` (AC7): o histórico do permalink venceu. Repetir a chamada não
    // resolve — a saída é refazer a busca, então aqui não aparece o botão de tentar de novo. O
    // `status` entra na decisão porque um 410 **sem envelope** chega com `code: "INTERNAL"`.
    if (state.code === "HISTORY_EXPIRED" || state.httpStatus === 410) {
      body = (
        <div>
          <h3 style={{ fontSize: font.size.title, margin: `0 0 ${space.sm}` }}>
            {STR.results.expired.heading}
          </h3>
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
        </div>
      );
    } else {
      body = (
        <ErrorState
          message={state.message}
          code={state.code}
          requestId={state.requestId}
          onRetry={() => setReloadKey((key) => key + 1)}
        />
      );
    }
  } else if (state.status === "ready") {
    // A consulta vem do servidor quando o contrato já a manda; senão, do que a navegação trouxe.
    const answer = withQuery(state.data, stateQuery(carriedState));
    body = (
      <>
        {/* Limite de uso: o aviso entra acima da resposta e não apaga o resultado anterior. */}
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
        {/*
          `key={request_id}`: resposta nova = folha nova, e o foco inicial do turno acontece
          **uma vez** por resposta, não a cada re-render (R6).
        */}
        <Transcript key={answer.request_id} response={answer} searchId={searchId} />
      </>
    );
  }

  return (
    <section aria-labelledby="results-heading">
      <h2
        id="results-heading"
        style={{
          fontSize: font.size.heading,
          fontWeight: font.weight.strong,
          letterSpacing: font.tracking.tight,
          lineHeight: font.leading.tight,
          margin: `0 0 ${space.md}`,
        }}
      >
        {STR.results.heading}
      </h2>

      {/*
        A linha de status — única e persistente. Nasce no carregamento e nunca é desmontada: um
        leitor de tela precisa observar a região **antes** da mutação. `role="status"` já implica
        `aria-live="polite"`; escrever o atributo de novo só duplicaria o anúncio.
      */}
      <p role="status" style={STATUS_STYLE}>
        {state.status === "loading" ? (
          <span className="thinking-rule" aria-hidden="true" />
        ) : null}
        {statusText(state)}
      </p>

      {body}
    </section>
  );
}
