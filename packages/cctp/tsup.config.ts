import { defineConfig } from "tsup";

export default defineConfig({
  // Two entry points: the main runtime surface and the Solana-free
  // `@starkware-libs/anystark-cctp/addresses` subpath (pure constants, zero imports).
  entry: ["src/index.ts", "src/addresses.ts"],
  // Inline the core constants rather than externalizing the dep, so the dist stays
  // self-contained for the boot guard and for consumers. The .d.ts keeps importing
  // core's types: tsup holds production deps external in the dts bundle.
  noExternal: ["@starkware-libs/anystark-core"],
  format: ["esm"],
  target: "es2021",
  dts: true,
  // Keep code-splitting on: the heavy @solana/* and anchor libs are loaded via
  // dynamic import() and must stay out of the main chunk.
  splitting: true,
  treeshake: true,
  sourcemap: true,
  clean: true,
});
