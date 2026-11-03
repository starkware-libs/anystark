# Vite & bundling guide

How the `@starkware-libs/anystark-*` packages behave in a bundler, what loads when, and why no
special Vite plugins are needed. Unless noted otherwise, the numbers below are
**measured** with `size-limit` (esbuild runner, brotli-compressed) on each
package's built `dist/`, against `garaga@1.1.0`; re-measure with `npm run size`
if you bump dependencies. The one exception is the garaga-chunk row, which
measures the shipped `node_modules/garaga` module directly with the esbuild
runner disabled (see §5).

## 1. TL;DR: what loads when

The packages are designed so a Vite/Rollup SPA only parses the heavy dependency
trees (garaga's WASM, the Solana libs) when the user actually reaches the code
that needs them, never at app boot.

| Path                                                                     | Trigger                                                         | Cost (brotli, measured)                                      |
| ------------------------------------------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------ |
| `@starkware-libs/anystark-react` + `@starkware-libs/anystark-core` entry | app boot (connector in the `connectors` list)                   | **4.42 kB**                                                  |
| `@starkware-libs/anystark-core` entry (standalone)                       | app boot                                                        | **3.78 kB**                                                  |
| garaga WASM chunk                                                        | first signature (`signRaw` → `buildEddsaSignatureFelts`)        | **~2.6 MB raw / 607 kB brotli** (lazy, first-signature only) |
| `@starkware-libs/anystark-cctp` entry                                    | only if the dapp imports `@starkware-libs/anystark-cctp` itself | **3.76 kB**                                                  |
| `@solana/web3.js` + `@solana/spl-token` + `@coral-xyz/anchor`            | first bridge call inside `@starkware-libs/anystark-cctp`        | lazy (dynamic `import()` in `bridge.ts`)                     |

The boot-path budgets are enforced in CI by `npm run size`; the lazy-loading
invariants (garaga off `@starkware-libs/anystark-core`/`@starkware-libs/anystark-react` boot, Solana/anchor off
`@starkware-libs/anystark-cctp` boot) are enforced per package by `npm run check:lazy` (see §5).

## 2. garaga under Vite: no plugin needed

`garaga` looks like it should need `vite-plugin-wasm` and
`vite-plugin-top-level-await`. It does **not**, because of how `garaga@1.1.0`
ships its WASM:

- **No `.wasm` asset ships.** The compiled WASM is **base64-inlined** inside
  `garaga/dist/index.mjs` as a single `data:application/wasm` blob (verified:
  `find node_modules/garaga -name '*.wasm'` is empty; one `data:application/wasm`
  occurrence in the JS). There is no separate file for Vite to fingerprint,
  copy, or serve.
- **No `import.meta.url`** anywhere in `index.mjs` (verified: 0 occurrences), so
  there is no asset-URL resolution for the bundler to rewrite.
- **No top-level `await`.** Instantiation is behind an explicit async `init()`
  that `@starkware-libs/anystark-core` calls inside `loadGaraga()` (see `packages/core/src/garaga.ts`),
  so no top-level-await plugin is needed either.

Because the WASM is inline and init is explicit, the only cost is a ~2.6 MB
(pre-compression) plain-JS chunk that the consumer's bundler code-splits behind
the dynamic `import("garaga")` and loads at the first signature.

### Node built-ins

`garaga/dist/index.mjs` contains exactly one node-builtin reference,
`from 'crypto'`. garaga's `package.json` declares a `browser` remap field
(`"crypto": "crypto-browserify"`, plus `stream`/`vm` browserify shims and
`"fs": false`), so a browser-targeting bundler (Vite/Rollup honor the `browser`
field) substitutes `crypto-browserify` and never pulls node's `crypto` onto the
browser path. No manual polyfill or `define` is required.

### vite.config.ts

```ts
// vite.config.ts: Vite + React 19 SPA consuming @starkware-libs/anystark-react
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // NOTE: no wasm/top-level-await plugins. garaga (lazily imported by @starkware-libs/anystark-core
  // at first signature) ships its WASM base64-inlined in plain JS with an
  // explicit async init(); there is no .wasm asset for Vite to handle.
  optimizeDeps: {
    // Dev-only ergonomics: pre-bundle garaga so the first lazy sign doesn't
    // trigger a "new dependency discovered, reloading" full page reload.
    include: ["garaga"],
  },
  build: {
    // The lazy garaga chunk is ~2.6 MB pre-compression (garaga 1.1.0). It is
    // NOT on the boot path; raise the warning threshold rather than chasing it.
    chunkSizeWarningLimit: 3000,
  },
});
```

`optimizeDeps.include: ["garaga"]` is a dev-server convenience: Vite pre-bundles
listed dependencies up front, so discovering garaga only at first-signature time
(a dynamic import) does not force a mid-session dep re-optimization + full page
reload. It has no effect on the production build; drop it if you prefer the
default lazy discovery.

## 3. Browser-only / no-SSR notes

The `@starkware-libs/anystark-*` packages are built for browser SPAs. Importing them under Node is
safe (the vitest suites and `check:lazy` import them under Node 20 with no
`window`/`document` access at module load), but some APIs are browser-only at
**call** time:

- `PhantomProviderWrapper.detect()` reads `window`; it is browser-only by
  design and must run in the browser, not during SSR.
- If a consumer server-renders, construct connectors inside client-only code (a
  lazy route, a `useEffect`, or a `"use client"` boundary), never at the module
  scope of an SSR-evaluated module.

No `window`/`document` access happens at **import** time, so bundling and SSR
module evaluation do not crash; only calling the browser-only APIs on the server
would.

## 4. `@starkware-libs/anystark-cctp` lazy boundary

`@starkware-libs/anystark-cctp` is **not** a dependency of `@starkware-libs/anystark-core` or `@starkware-libs/anystark-react`; a dapp only
pays for it if it imports `@starkware-libs/anystark-cctp` directly. Even then:

- The `@starkware-libs/anystark-cctp` entry itself is tiny (**3.76 kB**, measured).
- The heavy Solana libraries (`@solana/web3.js`, `@solana/spl-token`,
  `@coral-xyz/anchor`) are behind `await import(...)` inside
  `packages/cctp/src/bridge.ts` and load only at the first bridge call; there
  are zero static `@solana`/anchor imports in `src/`.

Recommendation: import `@starkware-libs/anystark-cctp` from the bridge feature route, ideally behind
a route-level `import()`, so even its small entry stays out of the app boot
chunk.

## 5. Measured bundle deltas & self-verification

Measured with `size-limit` (brotli), `garaga@1.1.0`. The three package-entry
rows are measured with the esbuild runner on each package's built `dist/`; the
garaga-chunk row is different (see its note):

| Entry                                                                     | Boot cost (brotli)   | Notes                                                                                                                                         |
| ------------------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `@starkware-libs/anystark-core`                                           | 3.78 kB              | built dist; garaga excluded (lazy)                                                                                                            |
| `@starkware-libs/anystark-core` single symbol (`deriveSolAccountAddress`) | 444 B                | built dist; tree-shaking smoke (budget 0.5 kB)                                                                                                |
| `@starkware-libs/anystark-react` + `@starkware-libs/anystark-core`        | 4.42 kB              | built dist; garaga excluded (lazy)                                                                                                            |
| `@starkware-libs/anystark-cctp`                                           | 3.76 kB              | built dist; Solana/anchor excluded (lazy)                                                                                                     |
| garaga lazy chunk                                                         | 607 kB (~2.6 MB raw) | NOT a package dist: measures `node_modules/garaga` with the esbuild runner disabled; informational (no limit), first-signature only, not boot |

The package-entry budgets are set to the measured size rounded up to the next
0.5 kB for headroom (so a small, expected fluctuation does not flip CI, while a
real regression still trips it). The garaga-chunk row carries **no limit**: it
only reports, so a garaga version bump can never spuriously fail the boot job.

The lazy invariants are locked per package by `npm run check:lazy`:

- `@starkware-libs/anystark-core` (`check:lazy` = `assert_lazy.mjs core`): static scan of the built
  dist and its sourcemap + a runtime boot guard + a positive control (the
  signing path must actually dynamic-import garaga), so garaga cannot enter the
  boot path.
- `@starkware-libs/anystark-cctp` (`assert_lazy.mjs cctp`): same static scan + runtime boot guard +
  positive control (a bridge read path dynamic-imports `@solana/web3.js`) for
  the Solana/anchor libs; cctp's dist is self-contained, so it imports cleanly
  under the guard.
- `@starkware-libs/anystark-react` (`assert_lazy.mjs react`): static scan **only**. `@starkware-libs/anystark-react`
  externalizes `@starkware-libs/anystark-core`, so garaga lives in core's dist, not react's; and
  importing react's dist under the guard would fail to resolve the external
  `@starkware-libs/anystark-core` (whose package `main` is a `.ts` source). The static scan catches
  a direct static garaga import in react's own source (it inspects both the
  emitted `.js` and the sourcemap's original source, so a tree-shaken import is
  still caught).

Run `npm run size` from the repo root to reproduce the sizes. To self-verify in
your own Vite app that garaga stays off the boot chunk:

```bash
npx vite build
# Confirm the entry chunk (dist/assets/index-*.js) contains no "garaga",
# and that a separate lazy chunk holds it:
grep -L garaga dist/assets/index-*.js       # entry: should print the filename (no match)
grep -rl garaga dist/assets/*.js            # some *other* chunk should match
# Or visualize:
npx source-map-explorer dist/assets/*.js
```

## 6. Build-memory note

Hosted build platforms cap the memory available to the Vite/Rollup build process
(commonly around 8 GB), and a large statically-reachable dependency tree can
exceed that ceiling. The AnyStark packaging keeps a consumer's build light in two ways
that actually reduce what the bundler has to process:

- `@starkware-libs/anystark-cctp` is off the default import path and the Solana libraries it uses sit
  behind dynamic `import()`, so a consumer that does not use CCTP never pulls
  `@solana/web3.js`/anchor into its build graph.
- `sideEffects: false` on `@starkware-libs/anystark-core`/`@starkware-libs/anystark-react`/`@starkware-libs/anystark-cctp` lets the bundler
  tree-shake unreached modules out of the build.

Lazy `import()` of garaga keeps its ~2.6 MB WASM out of the **boot bundle** and
defers it to first use at **runtime**; note that this does not remove garaga from
the build itself (the bundler still emits it as a separate chunk). If you adopt
the optional heavy paths, measure your build's peak memory before committing. The
CI gates (`npm run size` for boot budgets, `npm run check:lazy` per package for
the lazy invariants) keep the boot-size and lazy rules from regressing.
