/**
 * O texto da consulta que gerou a resposta.
 *
 * Outra frente está acrescentando `query: string | null` ao contrato de busca. O campo **pode
 * não ter chegado** ao bundle do servidor que esta tela consome, então o acesso é opcional de
 * propósito — `response.query` direto não compilaria enquanto o campo não existe. A cadeia é:
 * `response.query` → o que a navegação da tela de busca carregou em `location.state.query`
 * (`withQuery`, chamado pela rota) → `null`.
 *
 * A folha (`Transcript`) não lê a rota: ela recebe a resposta já normalizada e só chama
 * `carriedQuery`. Quem conhece `location` é a rota.
 *
 * `ResponseWithQuery` é uma **interseção**, não uma `interface extends`: quando o dia em que
 * `SearchResponse` declarar `query: string | null` chegar, uma redeclaração como `string | null |
 * undefined` seria "incorrectly extends", enquanto a interseção continua sendo `string | null`.
 * O arquivo fica válido antes e depois da chegada do campo, sem tocar em `types.ts` (que é de
 * outra frente).
 */
import type { SearchResponse } from "../../types";

/** A resposta do contrato **mais** o campo que está chegando. */
export type ResponseWithQuery = SearchResponse & { readonly query?: string | null };

function normalise(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** `query` quando o servidor já o manda; `null` quando o campo ainda não chegou ou veio vazio. */
export function carriedQuery(response: SearchResponse): string | null {
  const carried: ResponseWithQuery = response;
  return normalise(carried.query);
}

/**
 * Resposta com a consulta preenchida: a do servidor vence; sem ela, vale o texto que a tela de
 * busca mandou na navegação. Sem nenhum dos dois nada é inventado — a resposta fica como veio.
 */
export function withQuery(response: SearchResponse, fallback: string | null): SearchResponse {
  const text = carriedQuery(response) ?? normalise(fallback);
  if (text === null) return response;
  const merged: ResponseWithQuery = { ...response, query: text };
  return merged;
}
