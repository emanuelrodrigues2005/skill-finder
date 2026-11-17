import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";

import { getCategories } from "../api";
import { ErrorState } from "../components/States";
import { QUERY_MAX_LENGTH, QUERY_MIN_LENGTH, type Category } from "../types";

export default function SearchPage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [categories, setCategories] = useState<Category[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getCategories()
      .then((response) => {
        if (!cancelled) {
          setCategories(response.data);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : "could not load categories");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const trimmed = query.trim();
  const isValid = trimmed.length >= QUERY_MIN_LENGTH && trimmed.length <= QUERY_MAX_LENGTH;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isValid) {
      return;
    }
    // TODO(F2.6): chamar searchSkills() e navegar com o `request_id` real.
    navigate("/results", { state: { query: trimmed, category: category === "" ? null : category } });
  }

  return (
    <section>
      <h2 style={{ fontSize: "1.1rem" }}>Search</h2>

      {loadError ? (
        <ErrorState message={loadError} requestId={null} />
      ) : (
        <form onSubmit={handleSubmit}>
          <label htmlFor="query" style={{ display: "block", fontWeight: 600 }}>
            What do you need the skill to do?
          </label>
          <textarea
            id="query"
            name="query"
            rows={5}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            maxLength={QUERY_MAX_LENGTH}
            aria-describedby="query-help"
            style={{ width: "100%", marginTop: "0.5rem", padding: "0.5rem", boxSizing: "border-box" }}
          />
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
            onChange={(event) => setCategory(event.target.value)}
            style={{ marginTop: "0.5rem", padding: "0.4rem" }}
          >
            <option value="">Any category</option>
            {categories.map((item) => (
              <option key={item.slug} value={item.slug}>
                {item.label_en}
              </option>
            ))}
          </select>

          <div style={{ marginTop: "1.25rem" }}>
            <button type="submit" disabled={!isValid}>
              Search
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
