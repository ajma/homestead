import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server/index.ts"],
  outDir: "dist/server",
  format: ["esm"],
  platform: "node",
  target: "node24",
  // Bundle our own code; leave node_modules external so native bindings
  // (libSQL) are resolved at runtime rather than inlined.
  noExternal: [/^@shared\//],
  clean: true,
  sourcemap: true,
});
