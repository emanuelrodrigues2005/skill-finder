import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Suíte de UI e do cliente da API (issue #29). `globals` fica desligado de propósito: cada
// teste importa `describe`/`it`/`expect` de `vitest` e o auto-cleanup do Testing Library é
// registrado à mão em `src/test/setup.ts` (sem `globals` o RTL não registra nada sozinho).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    // Mesma origem do `vite dev`. `location.origin` precisa existir e ser estável: o shim de
    // URL relativa (`src/test/fetchBase.ts`) e o permalink de `/results` dependem dela.
    environmentOptions: { jsdom: { url: "http://localhost:5173" } },
    setupFiles: ["src/test/setup.ts"],
    // Só `*.test.ts(x)` executável. `src/types.test-d.ts` é checagem de atribuição do `tsc`,
    // não teste de runtime — o padrão abaixo não casa com ele.
    include: ["src/**/*.test.{ts,tsx}"],
    restoreMocks: true,
  },
});
