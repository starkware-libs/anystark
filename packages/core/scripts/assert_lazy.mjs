#!/usr/bin/env node
// Dep-agnostic lazy-loading lock. Asserts, against a shipped package's BUILT
// dist (what consumers install), that a set of heavy dependencies never enters
// the boot path: they must be reachable only through a dynamic `import(...)`.
//
// Usage: node assert_lazy.mjs <core|cctp|react>   (run after that package's build)
//
// Per shipped package (see PACKAGES below):
//   * core: forbid `garaga`. Static scan + runtime boot guard + positive control
//     (the signing path dynamic-imports garaga, proving the guard is armed).
//     Also asserts its `./cctp-addresses` subpath entry (dist/cctp_addresses.js)
//     imports cleanly under the same guard with NO exception (a `cleanEntries`
//     check): pure constants, zero imports, must never resolve garaga.
//   * cctp: forbid the Solana/anchor libs. Static scan + runtime boot guard +
//     positive control (a bridge read path dynamic-imports @solana/web3.js).
//     cctp's dist is self-contained, so it imports cleanly under the guard.
//     Also asserts its `./addresses` subpath entry (dist/addresses.js) imports
//     cleanly under the same guard with NO exception (a `cleanEntries` check):
//     unlike index.js, addresses.js must never resolve a forbidden dep, lazily
//     or otherwise.
//   * react: forbid `garaga`. STATIC SCAN ONLY. @starkware-libs/anystark-react externalizes
//     @starkware-libs/anystark-core (see its tsup.config `external`), so garaga lives in core's
//     dist, not react's; and importing react's dist under the boot guard would
//     fail to resolve the external `@starkware-libs/anystark-core` (whose package `main` is a .ts
//     source Node cannot import). So react has no runtime guard: the static
//     scan catches a DIRECT static garaga import in react's own source.
//
// "Static scan" inspects BOTH the emitted `.js` chunks AND the `.js.map`
// sourcesContent (the original source, which survives tree-shaking) for any
// static `from "dep"` / `import "dep"` / `require("dep")` (and `dep/subpath`),
// while allowing the dynamic `import("dep")` form.
//
// Exits non-zero on any violation.
/* global URL, console, process */
import { readFileSync, readdirSync } from "node:fs";
import { register } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PACKAGES = {
  core: {
    // dist relative to this script (packages/core/scripts/).
    distDir: "../dist/",
    forbidden: ["garaga"],
    requireLazyCallSite: "garaga",
    runtimeGuard: true,
    positiveControlLabel: "the signing path (buildEddsaSignatureFelts) dynamic-imports garaga",
    positiveControl: async (mod) => {
      // Valid-length dummy inputs pass the byte-length checks, then loadGaraga runs.
      await mod.buildEddsaSignatureFelts(new Uint8Array(32), new Uint8Array(64), new Uint8Array(1));
    },
    // The `./cctp-addresses` subpath (pure constants, zero imports) must import
    // cleanly under the SAME guard: it must never resolve a forbidden dep, not
    // even lazily. See step 6 below.
    cleanEntries: ["cctp_addresses.js"],
  },
  cctp: {
    distDir: "../../cctp/dist/",
    forbidden: ["@solana/web3.js", "@solana/spl-token", "@coral-xyz/anchor"],
    runtimeGuard: true,
    positiveControlLabel: "a bridge read path (solanaUsdcAta) dynamic-imports @solana/web3.js",
    positiveControl: async (mod) => {
      // solanaUsdcAta's first statement is `await import("@solana/web3.js")`, so
      // the guard trips before any config use or network access.
      const bridge = new mod.CctpBridge(mod.CCTP_TESTNET_CONFIG);
      await bridge.solanaUsdcAta("11111111111111111111111111111111");
    },
    // The `./addresses` subpath (pure constants, zero imports) must import
    // cleanly under the SAME guard: unlike index.js, it must never resolve a
    // forbidden dep, not even lazily. See step 6 below.
    cleanEntries: ["addresses.js"],
  },
  react: {
    distDir: "../../react/dist/",
    forbidden: ["garaga"],
    // No runtime guard: @starkware-libs/anystark-core is external and won't resolve in isolation.
    runtimeGuard: false,
  },
};

function staticRefPatterns(dep) {
  const escaped = dep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const specifier = `["']${escaped}(?:/[^"']*)?["']`; // dep or dep/subpath
  return [
    // `import ... from "dep"` / `export ... from "dep"`.
    new RegExp(`(?:^|[^.\\w])from\\s*${specifier}`),
    // Bare static side-effect import `import "dep"`. Dynamic `import(` has no
    // whitespace after `import`, so it is not matched here.
    new RegExp(`(?:^|[^.\\w])import\\s+${specifier}`),
    // `require("dep")`.
    new RegExp(`\\brequire\\(\\s*${specifier}\\s*\\)`),
  ];
}

function findStaticViolation(source, forbidden) {
  for (const dep of forbidden) {
    for (const pattern of staticRefPatterns(dep)) {
      if (pattern.test(source)) return dep;
    }
  }
  return null;
}

async function main() {
  const packageName = process.argv[2];
  const config = PACKAGES[packageName];
  if (!config) {
    throw new Error(
      `usage: assert_lazy.mjs <${Object.keys(PACKAGES).join("|")}> (got ${JSON.stringify(packageName)})`,
    );
  }

  const distDir = fileURLToPath(new URL(config.distDir, import.meta.url));
  const jsFiles = readdirSync(distDir).filter((name) => name.endsWith(".js"));
  if (jsFiles.length === 0)
    throw new Error(`${distDir} has no .js: build @starkware-libs/anystark-${packageName} first`);

  // 1. Static scan of every emitted chunk and its sourcemap's original source.
  //
  // KNOWN LIMITATION: the sourcesContent scan is
  // text-based, so a quoted static-import shape (e.g. `from "garaga"`) that
  // appears only inside a comment or string literal in a package's source could
  // spuriously trip it. We accept this: it surfaces as a self-evident CI failure
  // and the probability is low. Noted here so a future maintainer isn't surprised.
  //
  // For runtimeGuard:false packages (react) the sourcemap scan is the SOLE
  // mechanism. react has `sideEffects:false`, so a bare static `import "garaga"`
  // is tree-shaken out of the emitted `.js` and leaves no trace there; the
  // original source only survives in the sourcemap's sourcesContent. So we MUST
  // fail closed if that evidence is unavailable, otherwise laziness goes
  // unverified and the check would be falsely green.
  let sourceEntriesScanned = 0;
  for (const jsFile of jsFiles) {
    const source = readFileSync(path.join(distDir, jsFile), "utf8");
    const jsViolation = findStaticViolation(source, config.forbidden);
    if (jsViolation) {
      throw new Error(
        `${jsFile}: static/require reference to '${jsViolation}' - must be dynamic import("${jsViolation}") only`,
      );
    }
    const mapPath = path.join(distDir, jsFile + ".map");
    let sourcesContent = [];
    try {
      sourcesContent = JSON.parse(readFileSync(mapPath, "utf8")).sourcesContent || [];
    } catch (error) {
      if (!config.runtimeGuard) {
        throw new Error(
          `${jsFile}.map: cannot read/parse sourcemap (${error && error.message}); the lazy check cannot verify laziness for @starkware-libs/anystark-${packageName} without it, because sideEffects:false tree-shakes a bare static import out of the .js and the sourcemap sourcesContent is the only remaining evidence. Ensure sourcemap:true in the package's tsup config.`,
        );
      }
      // runtimeGuard:true package: the sourcemap scan is supplementary to the
      // runtime boot guard below, so a missing map is tolerated here.
    }
    for (const originalSource of sourcesContent) {
      if (originalSource) sourceEntriesScanned += 1;
      const sourceViolation =
        originalSource && findStaticViolation(originalSource, config.forbidden);
      if (sourceViolation) {
        throw new Error(
          `${jsFile}.map: source statically imports '${sourceViolation}' - must be dynamic import("${sourceViolation}") only`,
        );
      }
    }
  }

  // Fail closed for runtimeGuard:false packages: if no sourcesContent was
  // scanned across any chunk, the sole mechanism verified nothing.
  if (!config.runtimeGuard && sourceEntriesScanned === 0) {
    throw new Error(
      `@starkware-libs/anystark-${packageName}: no sourcemap sourcesContent found across dist chunks; the lazy check cannot verify laziness without it. Ensure sourcemap:true in the package's tsup config.`,
    );
  }

  // 2. The lazy call site must still exist (for packages that own the dynamic import).
  if (config.requireLazyCallSite) {
    const dep = config.requireLazyCallSite;
    const entry = readFileSync(path.join(distDir, "index.js"), "utf8");
    if (!new RegExp(`import\\(\\s*["']${dep}["']\\s*\\)`).test(entry)) {
      throw new Error(`dist/index.js: expected the lazy import("${dep}") call site - not found`);
    }
  }

  // 3. Static scan is enough for packages whose forbidden deps live elsewhere.
  if (!config.runtimeGuard) {
    console.log(
      `OK: @starkware-libs/anystark-${packageName} dist has no static import of [${config.forbidden.join(", ")}] (static scan; no runtime guard - external deps).`,
    );
    return;
  }

  // 4. Boot must not resolve any forbidden dep. Arm the guard, then import the entry.
  register(new URL("./garaga_boot_guard_hooks.mjs", import.meta.url), {
    parentURL: import.meta.url,
    data: { forbidden: config.forbidden },
  });
  const mod = await import(path.join(distDir, "index.js"));

  // 5. Positive control: a real code path MUST trip the guard, proving it is
  // armed and that the dep is genuinely reached via a dynamic import (no false green).
  let guardTripped = false;
  try {
    await config.positiveControl(mod);
  } catch (error) {
    guardTripped = String(error && error.message).includes("LAZY_BOOT_RESOLVED");
    if (!guardTripped) throw error;
  }
  if (!guardTripped) {
    throw new Error(
      `positive control failed: ${config.positiveControlLabel} did not trip the guard - it is not armed`,
    );
  }
  console.log(
    `OK: @starkware-libs/anystark-${packageName} boot loads none of [${config.forbidden.join(", ")}]; the lazy path does (lazy invariant holds).`,
  );

  // 6. `cleanEntries`: additional entries that must import cleanly under the
  // SAME armed guard, with no exception — proves a subpath (e.g. cctp's
  // `./addresses`) never resolves the forbidden deps, not even lazily.
  for (const file of config.cleanEntries || []) {
    await import(path.join(distDir, file));
  }
  if (config.cleanEntries?.length) {
    console.log(
      `OK: [${config.cleanEntries.join(", ")}] import cleanly under the guard (never resolve [${config.forbidden.join(", ")}], not even lazily).`,
    );
  }
}

await main();
