import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/web",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
    },
  },
  server: {
    proxy: { "/api": "http://localhost:7420" },
    // Vite serves localhost and bare IP addresses by default but refuses an
    // unrecognised hostname, which blunts DNS rebinding. Reaching a remote dev
    // box as http://homestead-test:5173 therefore needs that name listed.
    // Comma-separated; unset in normal local development.
    ...(process.env.VITE_ALLOWED_HOSTS
      ? {
          allowedHosts: process.env.VITE_ALLOWED_HOSTS.split(",")
            .map((h) => h.trim())
            .filter(Boolean),
        }
      : {}),
  },
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
});
