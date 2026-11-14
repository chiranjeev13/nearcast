import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev: `npm run dev` proxies /api to the nearcast server (or the mock), adding the token header.
const target = process.env.NEARCAST_API ?? "http://127.0.0.1:4141";
const token = process.env.NEARCAST_UI_TOKEN ?? "";

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@api": fileURLToPath(new URL("../src/ui/api.ts", import.meta.url)),
      crypto: fileURLToPath(new URL("./src/shims/crypto.ts", import.meta.url)),
      util: fileURLToPath(new URL("./src/shims/util.ts", import.meta.url)),
    },
  },
  define: { global: "globalThis" },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 4000 },
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": {
        target,
        changeOrigin: true,
        headers: token ? { "x-nearcast-token": token } : {},
      },
    },
  },
});
