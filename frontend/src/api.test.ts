// @vitest-environment node
/**
 * Cliente da API (issue #29) — dez casos de `messageForCode`, `describeApiError`, `searchSkills`
 * e `getSkills`.
 *
 * Ambiente `node`: aqui não há DOM, então o que se prova é o que o cliente **monta** (caminho,
 * corpo, query) e como ele **traduz** a falha. O `fetch` é substituído por um espião; o MSW não
 * entra neste arquivo.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, describeApiError, getSkills, messageForCode, searchSkills } from "./api";
import { errorEnvelope, REQUEST_ID, searchResponse } from "./test/fixtures/search";

afterEach(() => {
  // `vi.stubGlobal` não volta sozinho: `restoreMocks` cobre só `vi.spyOn`.
  vi.unstubAllGlobals();
});

/** Resposta mínima com corpo JSON, no status pedido. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Instala o espião de `fetch` e devolve o mock para as asserções de chamada. */
function stubFetch(response: Response) {
  const mock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("messageForCode", () => {
  it("maps a contract code to its own message", () => {
    expect(messageForCode("NOT_FOUND")).toBe("We could not find what you asked for.");
    expect(messageForCode("SOURCE_UNAVAILABLE")).toBe("Data source unavailable — try again later.");
  });

  it("falls back to the generic message for a code the UI does not know", () => {
    expect(messageForCode("SOMETHING_NEW_FROM_THE_SERVER")).toBe(
      "Something went wrong. Please try again.",
    );
  });

  it("appends the retry delay only for RATE_LIMITED with a positive value", () => {
    expect(messageForCode("RATE_LIMITED", 30)).toBe("Too many searches. Try again in 30 seconds.");
    expect(messageForCode("RATE_LIMITED", 1)).toBe("Too many searches. Try again in 1 second.");
    expect(messageForCode("RATE_LIMITED", 0)).toBe("Too many searches.");
    expect(messageForCode("RATE_LIMITED", null)).toBe("Too many searches.");
  });
});

describe("describeApiError", () => {
  it("returns the generic message and a null code for a non-ApiError failure", () => {
    expect(describeApiError(new TypeError("Failed to fetch"))).toEqual({
      message: "Something went wrong. Please try again.",
      code: null,
    });
  });

  it("recognises the unknown category by details.reason", () => {
    const error = new ApiError({
      status: 422,
      code: "VALIDATION_ERROR",
      requestId: REQUEST_ID,
      details: { reason: "UNKNOWN_CATEGORY" },
      serverMessage: "campo inválido",
    });

    expect(describeApiError(error)).toEqual({
      message: "That category does not exist. Pick one from the list.",
      code: "UNKNOWN_CATEGORY",
    });
  });

  it("recognises the unknown category by details.fields as well", () => {
    const error = new ApiError({
      status: 422,
      code: "VALIDATION_ERROR",
      requestId: null,
      details: { fields: ["category"] },
    });

    expect(describeApiError(error).code).toBe("UNKNOWN_CATEGORY");
  });

  it("never returns the server text, only the message of the code map", () => {
    const error = new ApiError({
      status: 500,
      code: "INTERNAL",
      requestId: REQUEST_ID,
      serverMessage: "stack trace do servidor: nomes de tabela vazaram",
    });

    const described = describeApiError(error);
    expect(described).toEqual({ message: "Something went wrong on our side. Try again.", code: "INTERNAL" });
    expect(described.message).not.toContain("stack trace");
  });
});

describe("searchSkills", () => {
  it("posts the normalised body to /api/v1/search and clamps the limit", async () => {
    const mock = stubFetch(jsonResponse(searchResponse));

    await searchSkills("  extract tables  ", "  documents  ", 999);

    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/search");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      query: "  extract tables  ",
      category: "documents",
      limit: 20,
    });
  });

  it("turns an error envelope into an ApiError with status, code, request id and details", async () => {
    stubFetch(
      jsonResponse(
        errorEnvelope("VALIDATION_ERROR", { details: { reason: "UNKNOWN_CATEGORY", fields: ["category"] } }),
        422,
      ),
    );

    const caught = await searchSkills("extract tables").catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(ApiError);
    const apiError = caught as ApiError;
    expect(apiError.status).toBe(422);
    expect(apiError.code).toBe("VALIDATION_ERROR");
    expect(apiError.requestId).toBe(REQUEST_ID);
    expect(apiError.details).toEqual({ reason: "UNKNOWN_CATEGORY", fields: ["category"] });
  });
});

describe("getSkills", () => {
  it("builds the contract query string with clamped page and page size", async () => {
    const mock = stubFetch(
      jsonResponse({ request_id: REQUEST_ID, data: [], pagination: { page: 1, page_size: 20, total_items: 0, total_pages: 0 } }),
    );

    await getSkills({ category: " documents ", sortBy: "installs", page: 0, pageSize: 500 });

    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/skills?category=documents&sort_by=installs&page=1&page_size=100");
    expect(init.method).toBeUndefined();
  });
});
