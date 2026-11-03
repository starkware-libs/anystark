#!/usr/bin/env node
// Prepare the AnyStark packages for `npm publish`.
//
// npm applies publishConfig only for a small allowlist of config keys (access, registry,
// tag, and similar); it leaves publishConfig.main/types/exports untouched in the published
// manifest (field-override for entry points is a pnpm/yarn extension, not npm). The
// committed manifests point main/types/exports at the TypeScript source under src/ so the
// workspace resolves source during development. Published unchanged, they would ship a
// package whose entry points resolve ./src/index.ts, which is absent from the tarball
// (files: ["dist"]).
//
// This script hoists each package's publishConfig.main/types/exports to the manifest top
// level, so the published package resolves the built dist. publishConfig keeps its
// remaining keys (registry, access) for `npm publish`.
//
// Modes:
//   (default)  Rewrite each publishable manifest in place. The CI publish job runs this
//              between `npm run build` and `npm publish`.
//   --verify   Token-free coherence check: apply the transform, run `npm publish
//              --dry-run` and `npm pack --dry-run` per package, assert every hoisted
//              entry-point path is present in the packed file list, then restore the
//              manifests byte-for-byte. Run after `npm run build`. Wired into node.yml and
//              exposed as `npm run publish:dry`.

/* global process, console, URL */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { PACKAGES } from "./publishable.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function manifestPath(pkgDir) {
  return fileURLToPath(new URL(`../${pkgDir}/package.json`, import.meta.url));
}

// Move publishConfig.{main,types,exports} to the manifest top level, replacing the
// src-pointing development values, and drop them from publishConfig (which keeps
// registry and access).
// Mutates and returns `manifest`; a no-op if the keys are already hoisted.
function hoistEntryPoints(manifest) {
  const publishConfig = manifest.publishConfig || {};
  for (const key of ["main", "types", "exports"]) {
    if (key in publishConfig) {
      manifest[key] = publishConfig[key];
      delete publishConfig[key];
    }
  }
  manifest.publishConfig = publishConfig;
  return manifest;
}

function writeManifest(path, manifest) {
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
}

// Every dist file path referenced by the manifest entry points (main, types, and the
// string leaves of exports), normalized without the leading "./".
function entryPointPaths(manifest) {
  const paths = new Set();
  const add = (value) => {
    if (typeof value === "string") paths.add(value.replace(/^\.\//, ""));
  };
  const walk = (node) => {
    if (typeof node === "string") add(node);
    else if (node && typeof node === "object") Object.values(node).forEach(walk);
  };
  add(manifest.main);
  add(manifest.types);
  walk(manifest.exports);
  return [...paths];
}

function npm(args) {
  return spawnSync("npm", args, { cwd: repoRoot, encoding: "utf8" });
}

function prepare() {
  for (const pkgDir of PACKAGES) {
    const path = manifestPath(pkgDir);
    const manifest = hoistEntryPoints(JSON.parse(readFileSync(path, "utf8")));
    writeManifest(path, manifest);
    console.log(`hoisted entry points for ${manifest.name}`);
  }
}

function verify() {
  // Snapshot the raw bytes so the restore is exact (a clean `git status` afterwards).
  const originals = new Map();
  for (const pkgDir of PACKAGES) {
    const path = manifestPath(pkgDir);
    originals.set(path, readFileSync(path, "utf8"));
  }

  const failures = [];
  try {
    for (const pkgDir of PACKAGES) {
      const path = manifestPath(pkgDir);
      const manifest = hoistEntryPoints(JSON.parse(originals.get(path)));
      writeManifest(path, manifest);
      const name = manifest.name;

      const dryRun = npm(["publish", "--dry-run", "-w", name]);
      if (dryRun.status !== 0) {
        failures.push(`${name}: npm publish --dry-run failed\n${dryRun.stderr}`);
        continue;
      }

      const pack = npm(["pack", "--dry-run", "--json", "-w", name]);
      if (pack.status !== 0) {
        failures.push(`${name}: npm pack --dry-run failed\n${pack.stderr}`);
        continue;
      }
      let report;
      try {
        const parsed = JSON.parse(pack.stdout);
        // `npm pack -w <name>` reports an object keyed by name; a bare invocation
        // reports an array. Take the single report either way.
        report = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
      } catch (error) {
        failures.push(`${name}: could not parse npm pack --json output: ${error.message}`);
        continue;
      }

      const packedFiles = new Set((report.files || []).map((file) => file.path));
      const entries = entryPointPaths(manifest);
      const missing = entries.filter((entry) => !packedFiles.has(entry));
      if (missing.length > 0) {
        failures.push(
          `${name}: entry points missing from the packed tarball: ${missing.join(", ")}. ` +
            `Build first (npm run build); the published package would fail to resolve them.`,
        );
        continue;
      }
      console.log(`OK: ${name} tarball contains all entry points [${entries.join(", ")}]`);
    }
  } finally {
    for (const [path, content] of originals) {
      writeFileSync(path, content);
    }
  }

  if (failures.length > 0) {
    console.error("publish verification failed:\n\n" + failures.join("\n\n"));
    process.exit(1);
  }
  console.log("OK: all AnyStark packages pack coherently with hoisted entry points.");
}

if (process.argv.includes("--verify")) {
  verify();
} else {
  prepare();
}
