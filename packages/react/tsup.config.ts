import { defineConfig } from "tsup";

export default defineConfig({
  // Two entry points: the main runtime surface and the test-only `@starkware-libs/anystark-react/testing`
  // double. Separate entries keep the test double out of the main runtime bundle.
  entry: ["src/index.ts", "src/testing.ts"],
  // TODO: Consider adding cjs support and a matching "require" condition
  // in package.json's exports if a CommonJS consumer ever needs require("@starkware-libs/anystark-react").
  format: ["esm"],
  target: "es2021",
  dts: true,
  splitting: true,
  treeshake: true,
  sourcemap: true,
  clean: true,
  // Keep the `node:` prefix on Node builtin imports (tsup strips it by default).
  // The @starkware-libs/anystark-react/testing entry imports `node:crypto`; without this tsup rewrites
  // it to a bare `crypto` specifier, which a browser bundler pointed at
  // @starkware-libs/anystark-react/testing would then try to polyfill. The explicit `node:` prefix
  // lets browser bundlers recognize it as a Node builtin and externalize it.
  removeNodeProtocol: false,
  // React and the core SDK are peer/external — never bundled into this package.
  external: ["react", "react-dom", "@starkware-libs/anystark-core"],
});
