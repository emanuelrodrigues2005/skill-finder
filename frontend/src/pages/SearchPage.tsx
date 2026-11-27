import { useEffect, useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { ApiError, describeApiError, getCategories, searchSkills } from "../api";
import { EmptyState, ErrorState, LoadingState } from "../components/States";
import { ThinkingTurn } from "../components/ThinkingTurn";
import { QUERY_MAX_LENGTH, QUERY_MIN_LENGTH, type Category } from "../types";
import { STR } from "../ui/strings";
import { color, font, radius, space } from "../ui/tokens";

/**
 * Rascunho da busca: sobrevive a voltar da tela de resultados e a um reload (US-09 AC2).
 * A versão vai na chave para que um formato antigo nunca quebre a leitura.
 */
const DRAFT_KEY = "skills-search:draft:v1";

interface Draft {
  query: string;
  category: string;
}

const EMPTY_DRAFT: Draft = { query: "", category: "" };

function readDraft(): Draft {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (raw === null) return EMPTY_DRAFT;
    const parsed = JSON.parse(raw) as Partial<Draft> | null;
    return {
      query: typeof parsed?.query === "string" ? parsed.query : "",
      category: typeof parsed?.category === "string" ? parsed.category : "",
    };
  } catch {
    // JSON inválido ou `sessionStorage` bloqueado (modo privado): começa limpo.
    return EMPTY_DRAFT;
  }
}

function writeDraft(draft: Draft): void {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Sem persistência: a busca continua funcionando, só não sobrevive ao reload.
  }
}

/** O que a tela mostra de uma falha — `code` é `null` quando ela não veio do envelope. */
interface Failure {
  message: string;
  code: string | null;
  requestId: string | null;
}

/**
 * Dica que a tela de resultados manda junto com a navegação de volta (issue #28): as ações do
 * estado vazio mexem no rascunho, e o rascunho mora aqui.
 *
 * `clearCategory` é a ação "Remover o filtro de categoria"; `exampleQuery` é "tentar um dos
 * exemplos". É o único caminho pelo qual `/results` altera o formulário — sem a dica, as três
 * ações do vazio seriam só links para `/`.
 */
interface SearchLocationState {
  clearCategory?: boolean;
  exampleQuery?: string;
}

/** Rascunho + dica de navegação: a consulta do exemplo manda; a categoria só é limpa se pedida. */
function applyHint(draft: Draft, hint: SearchLocationState | null): Draft {
  const example = typeof hint?.exampleQuery === "string" ? hint.exampleQuery : "";
  return {
    query: example === "" ? draft.query : example,
    category: hint?.clearCategory === true ? "" : draft.category,
  };
}

function describeFailure(error: unknown): Failure {
  return {
    ...describeApiError(error),
    requestId: error instanceof ApiError ? error.requestId : null,
  };
}

export default function SearchPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [initialDraft] = useState(() =>
    applyHint(readDraft(), (location.state as SearchLocationState | null) ?? null),
  );
  const [query, setQuery] = useState(initialDraft.query);
  const [category, setCategory] = useState(initialDraft.category);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loadingCategories, setLoadingCategories] = useState(true);
  const [categoriesFailure, setCategoriesFailure] = useState<Failure | null>(null);
  const [submitFailure, setSubmitFailure] = useState<Failure | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    writeDraft({ query, category });
  }, [query, category]);

  useEffect(() => {
    let cancelled = false;
    getCategories()
      .then((response) => {
        if (cancelled) return;
        setCategories(response.data);
        setLoadingCategories(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // Falha de categorias vira aviso ao lado do formulário, nunca substitui a busca.
        setCategoriesFailure(describeFailure(error));
        setLoadingCategories(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const trimmed = query.trim();
  const isValid = trimmed.length >= QUERY_MIN_LENGTH && trimmed.length <= QUERY_MAX_LENGTH;
  const categoryInList = categories.some((item) => item.slug === category);

  /**
   * O seletor de categoria só existe quando há categoria para selecionar.
   *
   * Fase 4 da auditoria: **nenhuma fonte publica categorias hoje** — `html-source.ts` e
   * `fixture-source.ts` devolvem `[]` com `supports_categories: false`, e `normaliseSkill`
   * fixa `category_slug: null`. Com `[]` e sem falha, o `<select>` tinha uma única opção
   * ("Todas as categorias") e a linha "nenhuma categoria disponível — você ainda pode buscar
   * sem uma" ao lado: a mensagem promete uma categoria que não vai chegar, porque a ausência
   * é da fonte, não do momento. Sem categoria, o rótulo e o `<select>` saem da tela juntos.
   *
   * As duas exceções são o motivo de a condição não ser `categories.length > 0`:
   * `loadingCategories` mantém o seletor desabilitado enquanto a lista chega (sem salto de
   * layout), e `categoriesFailure !== null` mantém o seletor com a mensagem de falha — ali
   * "nenhuma categoria disponível" é verdade transitória, não ausência permanente.
   *
   * Quando uma fonte passar a publicar categorias, `categories.length > 0` sozinho traz o
   * seletor de volta; não há flag a virar.
   */
  const categoryPickerVisible =
    loadingCategories || categoriesFailure !== null || categories.length > 0;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isValid || submitting) return;
    setSubmitting(true);
    setSubmitFailure(null);
    try {
      const response = await searchSkills(trimmed, category === "" ? null : category);
      // Só no sucesso: o permalink carrega o `request_id`, nunca o id interno da busca. A consulta
      // vai junto em `state` porque o contrato só passou a devolvê-la (`query`) agora: enquanto o
      // campo não chega ao bundle do servidor, a transcrição lê o texto daqui.
      navigate(`/results?search=${encodeURIComponent(response.request_id)}`, {
        state: { response, query: trimmed },
      });
    } catch (error) {
      // O 422 de categoria e o 503 de fonte caem no mesmo caminho; a exibição decide pelo
      // código que veio no envelope, nunca pelo status HTTP.
      setSubmitFailure(describeFailure(error));
      setSubmitting(false);
    }
  }

  /**
   * O aviso de submit pertence à tentativa que falhou. Assim que a pessoa mexe no que pode ter
   * causado a falha (texto ou categoria), ele sai da tela — não fica esperando o próximo submit.
   */
  function handleQueryChange(nextQuery: string) {
    setQuery(nextQuery);
    setSubmitFailure(null);
  }

  function handleCategoryChange(nextCategory: string) {
    setCategory(nextCategory);
    setSubmitFailure(null);
  }

  return (
    <section>
      {/* Aviso de categorias: irmão do formulário, porque o formulário sempre renderiza. */}
      {categoriesFailure ? (
        <div style={{ marginBottom: space.lg }}>
          <ErrorState
            message={categoriesFailure.message}
            code={categoriesFailure.code}
            requestId={categoriesFailure.requestId}
          />
          <p style={{ margin: `${space.sm} 0 0`, fontSize: font.size.compact, color: color.textMuted }}>
            {STR.search.categoriesUnavailableHint}
          </p>
        </div>
      ) : null}

      {/*
        A folha de medida: a consulta é o instrumento da tela, então ela ocupa a superfície
        branca com a borda de 1 px, e o rótulo acima é mono — o mesmo vocabulário do número do
        score na lista de resultados. Nada de caixa alta no rótulo: é o padrão que a gente
        evita de propósito.
      */}
      <form
        onSubmit={handleSubmit}
        style={{
          background: color.surface,
          border: `1px solid ${color.border}`,
          borderRadius: radius.sm,
          padding: space.xl,
        }}
      >
        <label
          htmlFor="query"
          style={{
            display: "block",
            fontFamily: font.family.mono,
            fontSize: font.size.meta,
            color: color.textMuted,
            marginBottom: space.xs,
          }}
        >
          {STR.search.queryLabel}
        </label>
        <textarea
          id="query"
          name="query"
          rows={3}
          value={query}
          onChange={(event) => handleQueryChange(event.target.value)}
          maxLength={QUERY_MAX_LENGTH}
          aria-invalid={query !== "" && !isValid}
          aria-describedby="query-help"
          style={{
            display: "block",
            width: "100%",
            boxSizing: "border-box",
            padding: `${space.sm} ${space.md}`,
            border: `1px solid ${color.hairline}`,
            borderRadius: radius.sm,
            background: color.surface,
            color: color.text,
            fontFamily: "inherit",
            fontSize: font.size.lead,
            lineHeight: font.leading.snug,
            resize: "vertical",
          }}
        />
        {/* O contador conta o texto aparado, que é o que o servidor julga. */}
        <p
          id="query-help"
          style={{
            margin: `${space.xs} 0 ${space.lg}`,
            fontFamily: font.family.mono,
            fontVariantNumeric: "tabular-nums",
            fontSize: font.size.meta,
            color: color.textMuted,
          }}
        >
          {STR.search.queryCounter(trimmed.length, QUERY_MAX_LENGTH, QUERY_MIN_LENGTH)}
        </p>

        <div
          style={{
            display: "flex",
            gap: space.md,
            alignItems: "end",
            flexWrap: "wrap",
          }}
        >
          <div style={{ flex: "1 1 16rem", minWidth: "12rem" }}>
            {categoryPickerVisible ? (
              <>
                <label
                  htmlFor="category"
                  style={{
                    display: "block",
                    fontFamily: font.family.mono,
                    fontSize: font.size.meta,
                    color: color.textMuted,
                    marginBottom: space.xs,
                  }}
                >
                  {STR.search.categoryLabel}
                </label>
                <select
                  id="category"
                  name="category"
                  value={category}
                  onChange={(event) => handleCategoryChange(event.target.value)}
                  disabled={loadingCategories}
                  style={{
                    width: "100%",
                    padding: `${space.sm} ${space.md}`,
                    border: `1px solid ${color.hairline}`,
                    borderRadius: radius.sm,
                    background: color.surface,
                    color: color.text,
                    fontFamily: "inherit",
                    fontSize: font.size.body,
                  }}
                >
                  <option value="">{STR.search.anyCategory}</option>
                  {/*
                    Ilha aceita e comentada: `label_en` NÃO é traduzido. O rótulo de categoria vem do
                    catálogo do skills.sh — é dado de terceiro, mostrado como publicado (AGENTS.md,
                    regra 6). Traduzi-lo aqui inventaria um rótulo que a fonte não tem, e o `value` é o
                    `slug` do contrato, que a busca envia de volta.
                  */}
                  {categories.map((item) => (
                    <option key={item.slug} value={item.slug}>
                      {item.label_en}
                    </option>
                  ))}
                  {/* Rascunho restaurado de uma categoria que a lista de agora não trouxe. */}
                  {category !== "" && !categoryInList ? <option value={category}>{category}</option> : null}
                </select>
              </>
            ) : null}
          </div>

          <button
            type="submit"
            disabled={!isValid || submitting}
            style={{
              padding: `${space.sm} ${space.xl}`,
              border: `1px solid ${color.link}`,
              borderRadius: radius.sm,
              background: color.link,
              color: color.onLink,
              fontFamily: "inherit",
              fontSize: font.size.body,
              fontWeight: font.weight.strong,
              cursor: isValid && !submitting ? "pointer" : "not-allowed",
              opacity: isValid && !submitting ? 1 : 0.55,
            }}
          >
            {submitting ? STR.search.submitting : STR.search.submit}
          </button>
        </div>

        {/*
          O "pensando" da busca: um turno da conversa abaixo do botão, que entra só depois de
          250 ms (resposta rápida não faz indicador piscar) e sai quando o `POST` resolve — no
          sucesso a navegação leva a resposta pronta para `/results`.
        */}
        {submitting ? (
          <div style={{ marginTop: space.md }}>
            <ThinkingTurn />
          </div>
        ) : null}

        {/* Carregando e vazio da lista de categorias (issue #28); o vazio agora só aparece
            quando houve falha — com o catálogo sem categorias, o seletor nem é renderizado. */}
        {loadingCategories ? (
          <div style={{ marginTop: space.md }}>
            <LoadingState label={STR.states.loading.categories} />
          </div>
        ) : null}
        {!loadingCategories && categoriesFailure !== null && categories.length === 0 ? (
          <div style={{ marginTop: space.md }}>
            <EmptyState message={STR.states.empty.noCategories} />
          </div>
        ) : null}

        {submitFailure ? (
          <div style={{ marginTop: space.lg }}>
            <ErrorState
              message={submitFailure.message}
              code={submitFailure.code}
              requestId={submitFailure.requestId}
            />
          </div>
        ) : null}
      </form>
    </section>
  );
}
