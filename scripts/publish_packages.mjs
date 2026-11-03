#!/usr/bin/env node
// Publish the AnyStark packages to npm in dependency order.
//
// Order: core, then cctp, then react, then paymaster-proxy (the @starkware-libs/anystark-core
// dependency of react and paymaster-proxy resolves as soon as core is up). Before each
// publish, `npm view <name>@<version> version`
// checks the registry; a version already present is skipped, so a first-ever publish and a
// rerun after a partial failure both do the right thing: a package with no published
// version resolves as unpublished (E404) and gets published, and an exact version match is
// skipped.
//
// Each package is published by running `npm publish` from inside the package's own
// directory (cwd), one npm process per package, rather than `npm publish -w <name>` from
// the workspace root. The registry and access for each publish come from that package's
// publishConfig (https://registry.npmjs.org, public).
//
// In CI, npm publish authenticates through each package's npm trusted publisher (OIDC). A
// package's first publish runs by hand under the maintainer's `npm login` session.
//
// Runs after `npm run build` and prepare_publish.mjs.
//
// Usage: node scripts/publish_packages.mjs [--dry-run]
//   --dry-run passes --dry-run through to `npm publish` and changes nothing else, so the
//   exact publish code path is exercisable without credentials.

/* global process, console, URL */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PACKAGES } from "./publishable.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const dryRun = process.argv.includes("--dry-run");

function readManifest(pkgDir) {
  return JSON.parse(readFileSync(join(repoRoot, pkgDir, "package.json"), "utf8"));
}

// True when name@version is already on the registry. `npm view` echoes the version and
// exits 0 when it exists; a missing version prints nothing (exit 0) and a package that
// does not exist yet exits nonzero (E404). Only an exact match counts as published, so a
// brand-new package or a new version publishes.
function isAlreadyPublished(name, version) {
  const result = spawnSync("npm", ["view", `${name}@${version}`, "version"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return result.status === 0 && result.stdout.trim() === version;
}

function publish(pkgDir, name) {
  const args = ["publish", ...(dryRun ? ["--dry-run"] : [])];
  const result = spawnSync("npm", args, {
    cwd: join(repoRoot, pkgDir),
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`npm publish (${name}) failed with exit code ${result.status}`);
  }
}

function main() {
  for (const pkgDir of PACKAGES) {
    const { name, version } = readManifest(pkgDir);
    if (isAlreadyPublished(name, version)) {
      console.log(`${name}@${version} already published, skipping`);
      continue;
    }
    console.log(`publishing ${name}@${version}${dryRun ? " (dry run)" : ""}`);
    publish(pkgDir, name);
  }
}

try {
  main();
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exit(1);
}
