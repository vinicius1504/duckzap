import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node24",
  platform: "node",
  clean: true,
  sourcemap: true,
  // pacotes do workspace são TS puro: entram no bundle; libs de npm ficam externas
  noExternal: [/^@duckzap\//],
});
