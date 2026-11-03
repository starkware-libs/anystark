#!/usr/bin/env node
// Guards the bundle gates against silent gaps. A "shipped" package is any
// workspace package that declares a `size-limit` budget; every one of them MUST
// also wire both `size` and `check:lazy` scripts. This is why CI does not lean
// on `npm run <script> --workspaces --if-present` fan-out: `--if-present` would
// silently skip a package that lost (or never added) one of these scripts,
// re-opening the exact hole these gates close. Adding a `size-limit`
// budget to a new package therefore forces it to also ship a lazy gate.
//
// Exits non-zero if any shipped package is missing `size` or `check:lazy`.
/* global URL, console, process */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REQUIRED_SCRIPTS = ["size", "check:lazy"];
const packagesDir = fileURLToPath(new URL("../../", import.meta.url));

const problems = [];
for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const manifestPath = path.join(packagesDir, entry.name, "package.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    continue; // Not a package directory.
  }
  if (!manifest["size-limit"]) continue; // Not a shipped (budgeted) package.

  const scripts = manifest.scripts || {};
  const missing = REQUIRED_SCRIPTS.filter((script) => !scripts[script]);
  if (missing.length > 0) {
    problems.push(`${manifest.name}: missing script(s) [${missing.join(", ")}]`);
  }
}

if (problems.length > 0) {
  console.error("shipped packages missing required bundle gates:\n  " + problems.join("\n  "));
  process.exit(1);
}
console.log("OK: every shipped package (size-limit budget) wires both `size` and `check:lazy`.");
