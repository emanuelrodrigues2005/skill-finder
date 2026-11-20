/**
 * Leitura e validação dos parâmetros de query de `GET /api/v1/skills` (§5.6).
 *
 * Existe por dois motivos, e os dois são deliberados:
 *
 * - **sem DTO em `@Query()`**: um tipo de classe em `@Query()` entra no
 *   `emitDecoratorMetadata` e o `@nestjs/swagger` registraria um componente novo
 *   no `openapi.yaml`. O contrato está congelado; os limites são lidos aqui;
 * - **um 422 que diz qual campo falhou**: o `details.fields` é o que o frontend
 *   usa para marcar o controle errado, então todas as violações da mesma query
 *   são reportadas juntas.
 */
import { HttpStatus } from '@nestjs/common';

import { ERROR_CODES } from '../common/errors/error-codes';
import { ApiError } from '../common/errors/http-exception.filter';

import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  DEFAULT_SKILL_SORT,
  MAX_PAGE_SIZE,
  SKILL_SORT_FIELDS,
  type SkillSortField,
} from './constants';

/**
 * Teto de `page` (§5.6).
 *
 * Sem ele, `/^\d+$/` aceita qualquer sequência de dígitos e `Number(raw)` estoura
 * para `Infinity` (ex.: `page=9` repetido 400 vezes) ou para um inteiro absurdo:
 * o `offset` infinito derruba o `Postgres` e a resposta sai **500**, onde o
 * contrato documenta 400/422. 10.000 × o teto de `page_size` (100) = 1.000.000
 * linhas de offset, muito além de qualquer catálogo real.
 */
export const MAX_PAGE = 10_000;

/** Valores de query já validados de `GET /api/v1/skills`. */
export interface SkillListParams {
  readonly page: number;
  readonly pageSize: number;
  readonly sortBy: SkillSortField;
  readonly category: string | null;
}

/**
 * Valor escalar de um parâmetro de query.
 *
 * `?page=1&page=2` chega como array: usar o primeiro valor é o que o Express
 * documenta, e evita `Number(['1','2'])` virar `NaN` sem ninguém perceber.
 */
export function queryValue(query: unknown, name: string): string | undefined {
  if (typeof query !== 'object' || query === null) {
    return undefined;
  }
  const raw: unknown = (query as Record<string, unknown>)[name];
  const first: unknown = Array.isArray(raw) ? (raw as unknown[])[0] : raw;
  if (typeof first !== 'string') {
    return undefined;
  }
  const trimmed = first.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Valor escalar de um parâmetro de caminho (`/skills/{skill_id}`).
 *
 * Mesma razão de {@link queryValue}: `@types/express@5` tipa o valor como
 * `string | string[]`, e um `string[]` nunca é um id válido.
 */
export function pathValue(params: unknown, name: string): string | undefined {
  return queryValue(params, name);
}

/**
 * Lê `page`, `page_size`, `sort_by` e `category` e devolve os defaults de §5.6.
 *
 * @throws ApiError 422 `VALIDATION_ERROR` com o nome de **cada** parâmetro
 *   inválido em `error.details.fields`.
 */
export function parseSkillListParams(query: unknown): SkillListParams {
  const fields: string[] = [];

  const page = integerQuery(query, 'page', fields);
  const pageSize = integerQuery(query, 'page_size', fields);
  // `page > MAX_PAGE` cobre também o `Infinity` de `Number('9'.repeat(400))`.
  if (page !== undefined && (page < 1 || page > MAX_PAGE)) {
    fields.push('page');
  }
  if (pageSize !== undefined && (pageSize < 1 || pageSize > MAX_PAGE_SIZE)) {
    fields.push('page_size');
  }

  const rawSort = queryValue(query, 'sort_by');
  const sortBy = rawSort ?? DEFAULT_SKILL_SORT;
  if (!SKILL_SORT_FIELDS.includes(sortBy as SkillSortField)) {
    fields.push('sort_by');
  }

  if (fields.length > 0) {
    throw new ApiError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      ERROR_CODES.VALIDATION_ERROR,
      'Request query failed validation.',
      { fields: [...new Set(fields)] },
    );
  }

  return {
    page: page ?? DEFAULT_PAGE,
    pageSize: pageSize ?? DEFAULT_PAGE_SIZE,
    sortBy: sortBy as SkillSortField,
    category: queryValue(query, 'category') ?? null,
  };
}

/** Inteiro positivo da query; valor não numérico já entra em `fields`. */
function integerQuery(query: unknown, name: string, fields: string[]): number | undefined {
  const raw = queryValue(query, name);
  if (raw === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(raw)) {
    fields.push(name);
    return undefined;
  }
  return Number(raw);
}
