import { Link, Navigate, Route, Routes } from "react-router-dom";

import DetailPage from "./pages/DetailPage";
import ResultsPage from "./pages/ResultsPage";
import SearchPage from "./pages/SearchPage";

export default function App() {
  return (
    <div
      style={{
        fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
        margin: "0 auto",
        maxWidth: 880,
        padding: "1.5rem 1rem 3rem",
        color: "#0f172a",
      }}
    >
      <header style={{ marginBottom: "1.5rem" }}>
        <Link to="/" style={{ textDecoration: "none", color: "inherit" }}>
          <h1 style={{ fontSize: "1.4rem", margin: 0 }}>Skills Search</h1>
        </Link>
        <p style={{ margin: "0.25rem 0 0", color: "#475569" }}>
          Describe the agent skill you need, in plain English.
        </p>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<SearchPage />} />
          <Route path="/results" element={<ResultsPage />} />
          <Route path="/skills/:id" element={<DetailPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
