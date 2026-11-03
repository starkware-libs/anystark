REF-PHASE-1-OK

# Phase 1 - foundation: install, flag, lazy seam

## Purpose

Get the AnyStark packages installed from npm, put the integration behind a
feature flag, and create the single lazy import seam so the SDK never enters the dapp's
boot bundle and flag-off builds are unchanged.

## Entry criteria

- P0 complete: plan confirmed, state file written.

## Checklist

- [ ] Packages installed: `^` ranges for core/react/cctp, an exact pin for
      `@starkware-libs/anystark-paymaster-proxy`; `starknet` peer dep resolved to ONE
      copy.
- [ ] All lockfiles regenerated in the same PR (lockfile parity).
- [ ] `.gitignore` entry for `.claude/*.local.json` (the state file).
- [ ] Feature flag defined per the P0 decision; default off.
- [ ] One seam module owns every `@starkware-libs/*` import, via dynamic `import()`.
- [ ] Flags-off passthrough stubs; flag-off builds gain no chunk and no failure mode.
- [ ] A CI guard enforces the seam (static-import grep test and/or bundle budget).

## PR plan

- **PR 1a "deps":** install `@starkware-libs/anystark-core` (plus
  `@starkware-libs/anystark-react` and its `@starknet-react/core` peer, `^5.0.3`, on the
  react lane;
  `@starkware-libs/anystark-cctp` when CCTP is in scope) with `^` ranges, and
  `@starkware-libs/anystark-paymaster-proxy` for the server part with an exact pin
  (`--save-exact`; it fronts the paymaster API key path, so its own README mandates
  exact pins reviewed deliberately); the `starknet` peer dep; lockfile(s) regenerated.
  Green trivially: no imports yet. Also carries the `.gitignore` entry for the state
  file.
- **PR 1b "flag + lazy seam + stubs":** one module (e.g. `src/lib/anystark.ts`) that is
  the ONLY place importing `@starkware-libs/*`, via dynamic `import()` behind the
  feature flag; flags-off passthrough stubs so non-integrated paths gain NO chunk
  dependency and NO new failure mode; a guard test (static-import grep test and/or
  bundle budget) that fails if anyone later imports the SDK statically from the boot
  path.

Each is reviewable in one sitting. 1a and 1b may merge into one PR in small repos; the
skill recommends the split and proceeds on repo size (derived decision).

## Catalog

- **Version discipline:** `^` ranges, except the paymaster proxy (exact pin, above).
  When the repo has more than one lockfile (e.g. bun
  for dev, npm for a Docker build), every dependency change regenerates ALL of them in
  the same PR. Split Docker contexts (api vs spa) may need separate build tsconfigs;
  probe before assuming one build covers both.
- **One `starknet` copy:** use `starknet@8.9.2`, the version the SDK develops and tests
  against. Core and cctp declare a peer range of `>=8.5.2 <11`; the react package
  declares `>=8.5.2 <9` (capped below 9 by `@starknet-react/core`'s own peer range), so
  a react-lane consumer stays on 8.x. Two resolved copies produce structurally
  distinct `Account` and typed-data types that fail to type-check at the SDK boundary
  even when the versions are identical: run `npm ls starknet` (or the manager's
  equivalent) after installing and dedupe to one.
- **Lazy seam:** the SDK stays out of the boot bundle; one module owns the dynamic
  `import()`. Measured boot costs when imported statically are small (core ~3.8 kB
  brotli, react+core ~4.4 kB), but garaga (~2.6 MB pre-compression) is lazily imported
  by core at first signature. No wasm or top-level-await bundler plugins are needed:
  garaga ships its WASM base64-inlined with an explicit async init. Vite:
  `optimizeDeps.include: ["garaga"]` is a dev-only nicety (avoids a mid-session reload
  at first sign); set `build.chunkSizeWarningLimit: 3000` rather than chasing the lazy
  chunk.
- **Flags-off stubs:** with the flag off, non-integrated paths must gain NO chunk
  dependency and NO new failure mode; passthrough stubs at the seam. Verify by building
  flag-off and checking the chunk graph and behavior. Add a repo-local guard (a grep
  test that no file outside the seam statically imports `@starkware-libs/`, or a size
  budget) so the invariant is CI-enforced, not tribal.
- **SSR:** the packages import cleanly under Node (no window/document at import time),
  but `PhantomProviderWrapper.detect()` and connector construction are browser-only at
  CALL time. Construct inside client-only boundaries (`"use client"`, `useEffect`, a
  lazy route), never at module scope of an SSR-evaluated module.

## Verification

- [ ] Install succeeds from a clean checkout in dev AND in CI.
- [ ] `npm ls starknet` (or equivalent) shows one resolved copy.
- [ ] Flag-off build: chunk graph unchanged, no `@starkware-libs` chunk on the boot
      path.
- [ ] The seam guard test fails when a static import is added outside the seam (mutation
      check), then passes restored.
- [ ] All lockfiles in sync.

## Exit criteria

- PR 1a and PR 1b merged (or the combined PR), CI green.

Sentinels for resume probes: `@starkware-libs/anystark-*` in `package.json`; the seam
module.
