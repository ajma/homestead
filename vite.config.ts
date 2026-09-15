import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { resolveDevServerOptions } from "./src/web/dev-server-options";

// Same env var and default the server reads for its own listen port (src/server/config.ts).
// Read directly rather than importing loadConfig: that validates the whole server env
// (HOMESTEAD_SECRET_KEY, HOMESTEAD_BASE_URL, ...), which this dev-only proxy target has no
// business requiring.
const apiPort = process.env.PORT || "3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
      "@web": fileURLToPath(new URL("./src/web", import.meta.url)),
    },
  },
  build: { outDir: "dist/web", emptyOutDir: true },
  server: {
    proxy: { "/api": `http://localhost:${apiPort}` },
    // Unset in ordinary local development. The hot-reload deployment (compose.dev.yaml)
    // sets these so the VM is reachable by hostname; see dev-server-options.ts.
    ...resolveDevServerOptions(process.env),
  },
});
