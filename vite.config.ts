import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
      "@web": fileURLToPath(new URL("./src/web", import.meta.url)),
    },
  },
  build: { outDir: "dist/web", emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:3000" } },
});
