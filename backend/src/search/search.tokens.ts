/**
 * Tokens de injeção das portas e da borda temporal da busca
 * (`docs/app/02-arquitetura.md` §3).
 *
 * String e não classe/símbolo porque o duplo de teste é `useValue` de um objeto
 * literal: um token de classe exigiria `useClass` e um construtor vazio.
 */
export const SEARCH_CATALOG = 'SEARCH_CATALOG';

export const SEARCH_STORE = 'SEARCH_STORE';

/** Persistência do orçamento global diário de chamadas da LLM (#35). */
export const DAILY_LLM_BUDGET_STORE = 'DAILY_LLM_BUDGET_STORE';
