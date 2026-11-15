import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// O navegador só fala com `/api`; em dev o Vite encaminha para o serviço `api`
// do Compose. Rodando o Vite fora do Compose, troque `target` para
// http://localhost:8080 (F2.7).
export default defineConfig({
  base: "/",
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": {
        target: "http://api:8000",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
