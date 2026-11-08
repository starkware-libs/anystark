#!/usr/bin/env node
// Set a new lockstep version across the publishable AnyStark packages.
//
// Writes X.Y.Z into every publishable package (core, cctp, react, paymaster-proxy) and sets
// the @starkware-libs/anystark-core dependency of each package that declares one to ^X.Y.Z
// (caret on 0.x admits only that minor, so a minor bump moves the floor with it), then syncs
// the lockfile with `npm install --package-lock-only`.
//
// It exists because `npm version --workspaces` is wrong for this repo: it does not update
// inter-workspace dependency ranges, it runs version lifecycle scripts, and it git-tags by
// default.
//
// Release flow: run this on a branch, `npm run format`, open and merge the PR, then
// `git tag vX.Y.Z && git push origin vX.Y.Z` to trigger the publish workflow.
//
// Usage: node scripts/bump_version.mjs X.Y.Z

/* global process, console, URL */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { PACKAGES } from "./publishable.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function manifestPath(pkgDir) {
  return fileURLToPath(new URL(`../${pkgDir}/package.json`, import.meta.url));
}

function main() {
  const version = process.argv[2];
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`usage: bump_version.mjs X.Y.Z (got ${JSON.stringify(version)})`);
  }

  for (const pkgDir of PACKAGES) {
    const path = manifestPath(pkgDir);
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    manifest.version = version;
    if (manifest.dependencies && manifest.dependencies["@starkware-libs/anystark-core"]) {
      manifest.dependencies["@starkware-libs/anystark-core"] = `^${version}`;
    }
    writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
    console.log(`set ${manifest.name} to ${version}`);
  }

  const install = spawnSync("npm", ["install", "--package-lock-only"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (install.status !== 0) {
    throw new Error(`npm install --package-lock-only failed with exit code ${install.status}`);
  }

  console.log(`OK: bumped to ${version}. Next: run npm run format, then commit.`);
}

try {
  main();
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exit(1);
}
