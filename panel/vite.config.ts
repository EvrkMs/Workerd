import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// В проде панель отдаёт api-воркер (panel.<ROOT_DOMAIN>), /api — там же.
// Для разработки: PANEL_API=http://... npm run dev — проксирует /api туда.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", assetsDir: "assets", sourcemap: false },
  server: {
    host: true,
    proxy: process.env.PANEL_API ? { "/api": { target: process.env.PANEL_API, changeOrigin: true } } : undefined,
  },
});
