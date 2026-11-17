import { setupServer } from "msw/node";

import { handlers } from "./handlers";

/**
 * Servidor MSW único da suíte. O ciclo de vida fica em `src/test/setup.ts`:
 * `listen` → shim de URL relativa → `resetHandlers` por teste → `close`.
 */
export const server = setupServer(...handlers);
