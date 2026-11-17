import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";

import { ApiError, describeApiError, getCategories, searchSkills } from "../api";
import { ErrorState } from "../components/States";
import { QUERY_MAX_LENGTH, QUERY_MIN_LENGTH, type Category } from "../types";

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

function describeFailure(error: unknown): Failure {
  return {
    ...describeApiError(error),
    requestId: error instanceof ApiError ? error.requestId : null,
  };
}

export default function SearchPage() {
  const navigate = useNavigate();
  const [initialDraft] = useState(readDraft);
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

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isValid || submitting) return;
    setSubmitting(true);
    setSubmitFailure(null);
    try {
      const response = await searchSkills(trimmed, category === "" ? null : category);
      // Só no sucesso: o permalink carrega o `request_id`, nunca o id interno da busca.
      navigate(`/results?search=${encodeURIComponent(response.request_id)}`, {
        state: { response },
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
      <h2 style={{ fontSize: "1.1rem" }}>Search</h2>

      {/* Aviso de categorias: irmão do formulário, porque o formulário sempre renderiza. */}
      {categoriesFailure ? (
        <div style={{ marginBottom: "1rem" }}>
          <ErrorState
            message={categoriesFailure.message}
            code={categoriesFailure.code}
            requestId={categoriesFailure.requestId}
          />
          <p style={{ margin: "0.5rem 0 0", fontSize: "0.85rem", color: "#475569" }}>
            You can still search without a category.
          </p>
        </div>
      ) : null}

      <form onSubmit={handleSubmit}>
        <label htmlFor="query" style={{ display: "block", fontWeight: 600 }}>
          What do you need the skill to do?
        </label>
        <textarea
          id="query"
          name="query"
          rows={5}
          value={query}
          onChange={(event) => handleQueryChange(event.target.value)}
          maxLength={QUERY_MAX_LENGTH}
          aria-invalid={query !== "" && !isValid}
          aria-describedby="query-help"
          style={{ width: "100%", marginTop: "0.5rem", padding: "0.5rem", boxSizing: "border-box" }}
        />
        {/* O contador conta o texto aparado, que é o que o servidor julga. */}
        <p id="query-help" style={{ margin: "0.25rem 0 1rem", color: "#475569" }}>
          {trimmed.length}/{QUERY_MAX_LENGTH} characters — at least {QUERY_MIN_LENGTH} required.
        </p>

        <label htmlFor="category" style={{ display: "block", fontWeight: 600 }}>
          Category (optional)
        </label>
        <select
          id="category"
          name="category"
          value={category}
          onChange={(event) => handleCategoryChange(event.target.value)}
          disabled={loadingCategories}
          style={{ marginTop: "0.5rem", padding: "0.4rem" }}
        >
          <option value="">Any category</option>
          {categories.map((item) => (
            <option key={item.slug} value={item.slug}>
              {item.label_en}
            </option>
          ))}
          {/* Rascunho restaurado de uma categoria que a lista de agora não trouxe. */}
          {category !== "" && !categoryInList ? <option value={category}>{category}</option> : null}
        </select>

        {submitFailure ? (
          <div style={{ marginTop: "1rem" }}>
            <ErrorState
              message={submitFailure.message}
              code={submitFailure.code}
              requestId={submitFailure.requestId}
            />
          </div>
        ) : null}

        <div style={{ marginTop: "1.25rem" }}>
          <button type="submit" disabled={!isValid || submitting}>
            {submitting ? "Searching…" : "Search"}
          </button>
        </div>
      </form>
    </section>
  );
}
