#!/usr/bin/env node
// Assert the release tag matches every publishable package version (lockstep release).
//
// The AnyStark packages release in lockstep under a single vX.Y.Z tag: every publishable
// package (core, cctp, react, paymaster-proxy) sits at that version, and every package that
// depends on @starkware-libs/anystark-core (react and paymaster-proxy) pins it at exactly
// ^X.Y.Z. The publish workflow runs this against the pushed tag before it hoists entry
// points and publishes, so a tag that disagrees with the manifests stops the release before
// anything reaches the registry.
//
// Usage: node scripts/assert_publish_versions.mjs vX.Y.Z

/* global process, console, URL */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PACKAGES } from "./publishable.mjs";

function readManifest(pkgDir) {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../${pkgDir}/package.json`, import.meta.url)), "utf8"),
  );
}

function main() {
  const tag = process.argv[2];
  if (!tag) {
    throw new Error("usage: assert_publish_versions.mjs vX.Y.Z");
  }
  const match = /^v(\d+\.\d+\.\d+)$/.exec(tag);
  if (!match) {
    throw new Error(`tag must look like vX.Y.Z, got: ${JSON.stringify(tag)}`);
  }
  const version = match[1];

  const expectedRange = `^${version}`;
  const errors = [];
  const names = [];
  const corePinnedNames = [];
  for (const pkgDir of PACKAGES) {
    const manifest = readManifest(pkgDir);
    names.push(manifest.name);
    if (manifest.version !== version) {
      errors.push(`${manifest.name} is at ${manifest.version}, tag expects ${version}`);
    }
    // Every publishable that depends on @starkware-libs/anystark-core must pin it at
    // exactly ^<version> (react and paymaster-proxy today). On the 0.x line a caret admits
    // only that minor, so the pin floor moves with each minor bump. This is exactly the
    // invariant bump_version.mjs writes, so both core-pinning packages are enforced here
    // the same way.
    const coreRange = manifest.dependencies?.["@starkware-libs/anystark-core"];
    if (coreRange !== undefined) {
      corePinnedNames.push(manifest.name);
      if (coreRange !== expectedRange) {
        errors.push(
          `${manifest.name} depends on @starkware-libs/anystark-core ${coreRange}, lockstep expects ${expectedRange}`,
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new Error("version assertions failed:\n" + errors.join("\n"));
  }
  console.log(
    `OK: ${names.join(", ")} are all at ${version}; ` +
      `${corePinnedNames.join(" and ")} pin core at ${expectedRange}.`,
  );
}

try {
  main();
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exit(1);
}
