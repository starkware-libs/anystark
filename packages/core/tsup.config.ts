import { defineConfig } from "tsup";

export default defineConfig({
  // Two entry points: the main runtime surface and the Solana-free
  // `@starkware-libs/anystark-core/cctp-addresses` subpath (pure constants, zero imports),
  // kept out of the main entry so it never enters the boot chunk.
  entry: ["src/index.ts", "src/cctp_addresses.ts"],
  // TODO: Consider adding cjs support and a matching "require" condition
  // in package.json's exports if a CommonJS consumer ever needs require("@starkware-libs/anystark-core").
  format: ["esm"],
  target: "es2021",
  dts: true,
  // Keep code-splitting on: dynamic import() boundaries (e.g. the lazily-loaded
  // garaga WASM) must stay separate chunks so consumers don't eat them eagerly.
  splitting: true,
  treeshake: true,
  sourcemap: true,
  clean: true,
});
