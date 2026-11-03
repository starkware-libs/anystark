#!/usr/bin/env node
// PAYMASTER_POLICY generator
//
// Turns contract addresses + plain FUNCTION NAMES + plain-language limits into a
// validated, env-ready one-line PAYMASTER_POLICY string. The most error-prone step
// of setting up the paymaster-proxy is hand-writing that JSON, including raw felt
// selectors (sn_keccak of a function name). This script removes all of that hand
// work: you pass function names, it computes the selectors, builds the policy, and
// round-trips the result through the proxy's REAL parser (configFromEnv) so it can
// never emit a string the proxy would reject at deploy time.
//
// Two modes:
//   Flag-driven (scriptable, testable): pass --call and limit flags on the command
//     line. See the flag reference below.
//   Interactive wizard (no args, on a TTY): asks the same questions one by one.
//
// The generator FAILS CLOSED on dangerous policies. A bare --call (any selector on a
// contract) requires --allow-any-selector, and a policy with neither a rateLimit nor
// a globalCap requires --allow-unbounded-budget. Without the matching acknowledgment
// the generator exits non-zero and prints nothing paste-ready, so a scripted
// `... > policy.env` capture cannot silently ship an over-broad or unbounded policy.
//
// Sponsoring the AnyStark account `deploy` class is mandatory, not a choice: a first-touch
// user (whose counterfactual AnyStark account is not yet deployed) is deployed as part of
// their first sponsored transaction, so that class must be sponsored. The account is the same
// derived address across every dapp that integrates AnyStark, so its creation is sponsored at
// most once per user (a returning user who already deployed it elsewhere incurs no further
// creation cost). The generator ALWAYS sets sponsoredClassHashes to the pinned AnyStark
// `deploy` class hash for the chosen chain (--chain, default sepolia), resolved from the built
// @starkware-libs/anystark-core.
// There is no flag to change or drop it; a chain with no pinned hash is rejected with an
// actionable error.
//
// Future: upgrade sponsorship (sponsoredSelfCalls for the account's `upgrade`
// entrypoint) will also be emitted automatically once the proxy-side policy field
// lands (separate PR); no flag will control it either.
//
// Run with -h / --help for the full flag reference.
//
// This script never sets allowInMemoryStore (a local/test footgun) and never prints
// the upstream API key or any other secret.
//
// In this monorepo, build first: the default class hash resolves through
// @starkware-libs/anystark-core and the validation round-trip imports the proxy's built
// parser, both from dist:
//   npm run -w @starkware-libs/anystark-core build
//   npm run -w @starkware-libs/anystark-paymaster-proxy build
// Installed as a published package this step is unnecessary: both packages ship
// prebuilt output, and this file runs as the anystark-paymaster-policy bin.

/* global process, console, URL */
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { hash, num } from "starknet";

// The Starknet field prime: 2^251 + 17*2^192 + 1. A valid felt is in [0, P). Kept
// in sync with normalizeFelt in src/policy.ts so the generator rejects the same
// out-of-range values the proxy would, before the round-trip even runs.
const FIELD_PRIME = 2n ** 251n + 17n * 2n ** 192n + 1n;

// Value-level errors (a bad felt, spec, or chain the caller typed) append this short
// pointer; flag-level errors (unknown flag, missing value) append the full USAGE.
const USAGE_HINT = "run with --help for usage";

export const USAGE = `Usage: node packages/paymaster-proxy/scripts/generate_policy.mjs [flags]

  --call <address>[:<fn1>,<fn2>,...]   Allowlist calls to <address> (repeatable).
                                       With a function list, only those selectors are
                                       allowed. Omit the ":" and list to allow ANY
                                       selector (broad: requires --allow-any-selector).
                                       Repeating the same address with function lists
                                       merges (union) the selectors.
  --allow-any-selector                 Acknowledge any bare --call (any-selector) entry.
  --rate-limit <maxPerAddress>/<windowSec>   e.g. 20/3600
  --global-cap <maxPerWindow>/<windowSec>    e.g. 5000/3600
  --allow-unbounded-budget             Acknowledge a policy with no rateLimit/globalCap.
  --chain <name|chainId>               Chain whose pinned AnyStark deploy class hash is
                                       sponsored (always on; not optional). Default sepolia.
  --pretty                             Also print indented JSON for review.
  -h, --help                           Print this message.

Run with no arguments on a TTY for an interactive wizard.`;

/**
 * Validate `value` as a 0x-prefixed hex felt in [1, FIELD_PRIME) and return it in
 * canonical zero-padded form (0x + 64 hex chars). `label` names the offending value
 * in the error message. Rejects decimals, malformed hex ("0xZZ", "0x") and
 * out-of-range values so a bad address/class-hash/selector fails with a clear
 * generator-side message instead of surfacing only from the deep round-trip.
 */
export function canonicalizeFelt(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!/^0x[0-9a-fA-F]+$/.test(text)) {
    throw new Error(
      `${label} must be a 0x-prefixed hex felt, got: ${JSON.stringify(value)}\n${USAGE_HINT}`,
    );
  }
  const parsed = BigInt(text);
  if (parsed <= 0n) {
    throw new Error(`${label} must be a non-zero felt, got: ${value}\n${USAGE_HINT}`);
  }
  if (parsed >= FIELD_PRIME) {
    throw new Error(
      `${label} is out of felt range (>= the Starknet field prime): ${value}\n${USAGE_HINT}`,
    );
  }
  return num.toHex64("0x" + parsed.toString(16));
}

/**
 * Resolve a selector from either a function name or an already-computed felt.
 * A value starting with `0x` is treated as a felt and canonicalized; anything else
 * is treated as a function name and hashed with sn_keccak (starknet.js
 * `hash.getSelectorFromName`). Returns canonical zero-padded felt form.
 */
export function computeSelector(functionNameOrFelt) {
  const text = String(functionNameOrFelt).trim();
  if (text === "") {
    throw new Error(`selector: empty function name or felt\n${USAGE_HINT}`);
  }
  if (text.startsWith("0x")) {
    return canonicalizeFelt(text, "selector felt");
  }
  return num.toHex64(hash.getSelectorFromName(text));
}

// Split "<count>/<windowSec>" into two positive integers. `flagName` names the flag
// in the error so a bad spec is easy to fix.
function parsePairSpec(spec, flagName) {
  const parts = String(spec).split("/");
  const firstValue = Number(parts[0]);
  const secondValue = Number(parts[1]);
  if (
    parts.length !== 2 ||
    !Number.isInteger(firstValue) ||
    firstValue <= 0 ||
    !Number.isInteger(secondValue) ||
    secondValue <= 0
  ) {
    throw new Error(
      `${flagName} must be two positive integers <count>/<windowSec>, e.g. 20/3600, got: ${spec}\n${USAGE_HINT}`,
    );
  }
  return { firstValue, secondValue };
}

/** Parse "20/3600" into `{ maxPerAddress: 20, windowSec: 3600 }`. */
export function parseRateLimit(spec) {
  const { firstValue, secondValue } = parsePairSpec(spec, "--rate-limit");
  return { maxPerAddress: firstValue, windowSec: secondValue };
}

/** Parse "5000/3600" into `{ maxPerWindow: 5000, windowSec: 3600 }`. */
export function parseGlobalCap(spec) {
  const { firstValue, secondValue } = parsePairSpec(spec, "--global-cap");
  return { maxPerWindow: firstValue, windowSec: secondValue };
}

/**
 * Parse one `--call` spec: "<address>:<fn1>,<fn2>" or "<address>" alone. The address
 * is everything before the first ":"; the (optional) comma-separated function list
 * follows. A ":" with no non-empty function names ("addr:", "addr:,", "addr:,,") is a
 * HARD ERROR rather than a silent widening to any-selector. Felt validation is
 * deferred to buildPolicy so parsing stays a pure string split.
 */
export function parseCallSpec(spec) {
  const separatorIndex = spec.indexOf(":");
  if (separatorIndex < 0) {
    return { to: spec.trim(), functions: [] };
  }
  const address = spec.slice(0, separatorIndex).trim();
  const functions = spec
    .slice(separatorIndex + 1)
    .split(",")
    .map((functionName) => functionName.trim())
    .filter((functionName) => functionName !== "");
  if (functions.length === 0) {
    throw new Error(
      `--call "${spec}": trailing ":" with no function names - list functions after the ` +
        `colon, or omit the colon entirely to allow any selector\n${USAGE_HINT}`,
    );
  }
  return { to: address, functions };
}

/**
 * The policy-shaping fields shared by the flag parser and the interactive wizard.
 * The flag parser layers `pretty`/`help` (presentation-only) on top; the wizard
 * derives `pretty` locally and never needs `help`, so neither lives here.
 */
export function createDefaultOptions() {
  return {
    calls: [],
    rateLimit: undefined,
    globalCap: undefined,
    chain: "sepolia",
    allowAnySelector: false,
    allowUnboundedBudget: false,
  };
}

/**
 * Parse the flag-driven argv (already sliced past `node script.mjs`) into a
 * structured options object. Throws (with usage appended) on unknown flags, a flag
 * missing its value, or a malformed rate-limit / global-cap / chain value.
 */
export function parseCliArgs(argv) {
  const options = { ...createDefaultOptions(), pretty: false, help: false };

  let index = 0;
  const nextValue = (flagName) => {
    index += 1;
    if (index >= argv.length) {
      throw new Error(`${flagName} requires a value\n\n${USAGE}`);
    }
    return argv[index];
  };

  for (index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case "--call":
        options.calls.push(parseCallSpec(nextValue("--call")));
        break;
      case "--allow-any-selector":
        options.allowAnySelector = true;
        break;
      case "--rate-limit":
        options.rateLimit = parseRateLimit(nextValue("--rate-limit"));
        break;
      case "--global-cap":
        options.globalCap = parseGlobalCap(nextValue("--global-cap"));
        break;
      case "--allow-unbounded-budget":
        options.allowUnboundedBudget = true;
        break;
      case "--chain":
        options.chain = nextValue("--chain");
        break;
      case "--pretty":
        options.pretty = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`unknown flag: ${flag}\n\n${USAGE}`);
    }
  }

  return options;
}

/**
 * Merge parsed `--call` specs into the `allowedCalls` array, canonicalizing every
 * address so entries that differ only by leading-zero padding collapse together.
 *
 * This mirrors the proxy's compileAllowlist, which keys its target map on the
 * canonical address and so keeps only the LAST entry per address. Emitting multiple
 * raw entries for one address would silently drop all but the last; instead we:
 *   - MERGE multiple function-list entries for one address into a single entry whose
 *     selectors are the deduped union.
 *   - COLLAPSE repeated bare (any-selector) entries into one bare entry.
 *   - HARD ERROR when an address appears both bare and with a function list, since
 *     the two express contradictory intent and the proxy would keep only one.
 */
function mergeAllowedCalls(calls) {
  const groupsByAddress = new Map();
  const addressOrder = [];
  for (const call of calls) {
    const canonicalAddress = canonicalizeFelt(call.to, "call address");
    if (!groupsByAddress.has(canonicalAddress)) {
      groupsByAddress.set(canonicalAddress, {
        bareSpellings: [],
        functionSpellings: [],
        selectors: [],
      });
      addressOrder.push(canonicalAddress);
    }
    const group = groupsByAddress.get(canonicalAddress);
    if (call.functions.length === 0) {
      group.bareSpellings.push(call.to);
    } else {
      group.functionSpellings.push(call.to);
      for (const functionName of call.functions) {
        group.selectors.push(computeSelector(functionName));
      }
    }
  }

  const allowedCalls = [];
  for (const canonicalAddress of addressOrder) {
    const group = groupsByAddress.get(canonicalAddress);
    const hasBare = group.bareSpellings.length > 0;
    const hasFunctions = group.functionSpellings.length > 0;
    if (hasBare && hasFunctions) {
      throw new Error(
        `--call ${canonicalAddress} is given both as a bare any-selector entry ` +
          `(${group.bareSpellings.join(", ")}) and with a function list ` +
          `(${group.functionSpellings.join(", ")}). These express contradictory intent ` +
          `and the proxy would keep only one. Either list every allowed function in a ` +
          `single --call ${canonicalAddress}:fn1,fn2 or use a single bare --call ` +
          `${canonicalAddress}.\n${USAGE_HINT}`,
      );
    }
    if (hasBare) {
      allowedCalls.push({ to: canonicalAddress });
    } else {
      const seenSelectors = new Set();
      const dedupedSelectors = [];
      for (const selector of group.selectors) {
        if (!seenSelectors.has(selector)) {
          seenSelectors.add(selector);
          dedupedSelectors.push(selector);
        }
      }
      allowedCalls.push({ to: canonicalAddress, selectors: dedupedSelectors });
    }
  }
  return allowedCalls;
}

/**
 * Build the SponsorshipPolicy object from parsed options. `deployClassHash` is the
 * pinned AnyStark `deploy` class hash for the chosen chain (see
 * resolveSponsoredDeployClassHash); sponsoring AnyStark account deployment is mandatory,
 * so it is ALWAYS the sole entry in sponsoredClassHashes and there is no flag to
 * change or drop it. All felts (addresses, selectors, the class hash) are
 * canonicalized here, so a malformed value throws a clear error naming its field.
 */
export function buildPolicy(options, deployClassHash) {
  const allowedCalls = mergeAllowedCalls(options.calls);
  const sponsoredClassHashes = [canonicalizeFelt(deployClassHash, "deploy class hash")];

  const policy = { allowedCalls, sponsoredClassHashes };
  if (options.rateLimit) policy.rateLimit = options.rateLimit;
  if (options.globalCap) policy.globalCap = options.globalCap;
  return policy;
}

/**
 * Dangerous-but-legitimate properties of a built policy that require an explicit
 * acknowledgment before the generator will emit a paste-ready string. Each entry
 * carries the `kind` (matched against an ack option), the `flag` that acknowledges
 * it, and a human `message` naming exactly what is broad and why. Pure so both the
 * flag gate and the wizard's per-condition confirmation can share it.
 */
export function dangerousConditions(policy) {
  const conditions = [];
  const anySelectorAddresses = policy.allowedCalls
    .filter((call) => !call.selectors)
    .map((call) => call.to);
  if (anySelectorAddresses.length > 0) {
    conditions.push({
      kind: "anySelector",
      flag: "--allow-any-selector",
      message:
        `policy allows ANY selector on: ${anySelectorAddresses.join(", ")}. ` +
        `Every function on ${anySelectorAddresses.length > 1 ? "those contracts" : "that contract"} ` +
        `would be sponsored. Re-run with --allow-any-selector to confirm.`,
    });
  }
  if (!policy.rateLimit && !policy.globalCap) {
    conditions.push({
      kind: "unboundedBudget",
      flag: "--allow-unbounded-budget",
      message:
        "policy sets neither rateLimit nor globalCap, so the sponsorship budget is " +
        "UNBOUNDED. Re-run with --allow-unbounded-budget to confirm.",
    });
  }
  return conditions;
}

/** True if `options` carries the acknowledgment flag for `condition`. */
function conditionAcknowledged(condition, options) {
  if (condition.kind === "anySelector") return options.allowAnySelector === true;
  if (condition.kind === "unboundedBudget") return options.allowUnboundedBudget === true;
  return false;
}

/** Dangerous conditions present in `policy` that `options` has NOT acknowledged. */
export function unacknowledgedConditions(policy, options) {
  return dangerousConditions(policy).filter(
    (condition) => !conditionAcknowledged(condition, options),
  );
}

/**
 * Resolve, per `--call` entry, the canonical contract address and the canonical
 * selector each function name maps to. Pure (no I/O) so it can be unit-tested and so
 * the caller can echo it for the owner to eyeball before shipping. This is how a
 * typo like `trasnfer` gets caught. Raw-felt function inputs echo their canonical
 * felt. `functions` is empty for a bare (any-selector) entry.
 */
export function describeSelectorMapping(calls) {
  return calls.map((call) => ({
    address: canonicalizeFelt(call.to, "call address"),
    functions: call.functions.map((functionName) => ({
      functionName,
      selector: computeSelector(functionName),
    })),
  }));
}

/** Serialize the policy to the exact one-line JSON string set as PAYMASTER_POLICY. */
export function serializePolicy(policy) {
  return JSON.stringify(policy);
}

/**
 * Non-fatal advisories about a built policy: an empty allowlist, any-selector
 * entries, and a missing budget limit are all legitimate but worth flagging so an
 * owner does not accidentally ship an over-broad or unbounded policy.
 */
export function policyWarnings(policy) {
  const warnings = [];
  if (policy.allowedCalls.length === 0) {
    warnings.push(
      "policy has NO allowedCalls: no invoke call can be sponsored. Add --call <address>:<fn> entries.",
    );
  }
  for (const call of policy.allowedCalls) {
    if (!call.selectors) {
      warnings.push(
        `allowedCalls entry ${call.to} has no selectors: ANY selector on this contract will be sponsored (legitimate but broad).`,
      );
    }
  }
  if (!policy.rateLimit && !policy.globalCap) {
    warnings.push(
      "neither rateLimit nor globalCap is set: the sponsorship budget is UNBOUNDED. Consider --rate-limit and/or --global-cap.",
    );
  }
  return warnings;
}

// Import the proxy's built parser. Dynamic (not top-level) so importing this module
// for the pure-core unit tests does not require dist to exist; only the runtime
// validation path below needs it.
async function loadRealParser() {
  const configUrl = new URL("../dist/src/config.js", import.meta.url);
  try {
    return await import(configUrl.href);
  } catch (cause) {
    throw new Error(
      "could not import the compiled proxy parser at packages/paymaster-proxy/dist/src/config.js.\n" +
        "build the package first: npm run -w @starkware-libs/anystark-paymaster-proxy build",
      { cause },
    );
  }
}

/**
 * Round-trip the serialized policy through the proxy's REAL configFromEnv so the
 * generator never emits a string the proxy would refuse at deploy time. Throws the
 * parser's own error if the policy is rejected.
 *
 * When the policy sets a rateLimit/globalCap, configFromEnv fail-closes unless a
 * durable store is configured. That is a deployment concern (the owner sets the
 * Upstash vars separately, and the next-steps output reminds them), not a policy
 * defect, so we pass placeholder Upstash vars here to isolate the check to the
 * policy shape and its felts.
 */
export async function validateThroughRealParser(policyString, { limited } = {}) {
  const { configFromEnv } = await loadRealParser();
  const env = {
    PAYMASTER_API_KEY: "policy-generator-validation-only",
    PAYMASTER_POLICY: policyString,
  };
  if (limited) {
    env.UPSTASH_REDIS_REST_URL = "https://policy-generator-validation.invalid";
    env.UPSTASH_REDIS_REST_TOKEN = "policy-generator-validation-only";
  }
  configFromEnv(env);
}

/**
 * Resolve the pinned AnyStark `deploy` class hash for `chainArg`, which is either a chain
 * name (mapped through `chainIds`, e.g. "sepolia") or a raw chainId felt. Sponsoring
 * AnyStark account deployment is mandatory, so this hash is always the sole
 * sponsoredClassHashes entry. When no hash is pinned for the chain, `resolve` throws
 * and we surface the actionable "not supported by AnyStark yet" error instead of a manual
 * override. Pure and dependency-injected (`chainIds`, `resolve` come from @starkware-libs/anystark-core)
 * so it is unit-testable without the built dist.
 */
export function resolveSponsoredDeployClassHash(chainArg, chainIds, resolve) {
  const chainId = chainIds[chainArg] ?? chainArg;
  try {
    return resolve({ chainId });
  } catch {
    throw new Error(
      `chain "${chainArg}" is not supported by AnyStark yet: no AnyStark account class hash is ` +
        `pinned for it. Supported chains are listed in @starkware-libs/anystark-core's SOL_ACCOUNT_CLASS_HASHES; ` +
        `re-run with --chain set to one of them.\n${USAGE_HINT}`,
    );
  }
}

// Resolve @starkware-libs/anystark-core's CHAIN_IDS + resolveDeployClassHash, memoized.
// Ordered dual resolution serves both audiences the generator has:
//   (a) an installed package (npm consumer), or any context where core resolves to
//       runnable JS: a plain package-name import resolves the published core's hoisted
//       main (dist/index.js), and @starkware-libs/anystark-core is a dependency of this
//       package so the install always provides it.
//   (b) this monorepo: the package-name import fails because the workspace core's
//       manifest main points at TypeScript source plain node cannot execute, so fall
//       back to the built dist at packages/core/dist/index.js.
// If both fail, throw one error naming the fix for each audience.
let coreResolverPromise;
async function loadCoreResolver() {
  if (!coreResolverPromise) {
    coreResolverPromise = (async () => {
      try {
        return await import("@starkware-libs/anystark-core");
      } catch (installedCause) {
        try {
          return await import(new URL("../../core/dist/index.js", import.meta.url).href);
        } catch (monorepoCause) {
          throw new Error(
            "could not import @starkware-libs/anystark-core.\n" +
              "In this monorepo, build core first: npm run -w @starkware-libs/anystark-core build.\n" +
              "As an installed package, @starkware-libs/anystark-core is a dependency of " +
              "@starkware-libs/anystark-paymaster-proxy; reinstall it.",
            { cause: monorepoCause ?? installedCause },
          );
        }
      }
    })();
  }
  return coreResolverPromise;
}

// Resolve the mandatory anystark deploy class hash for `chain` from the built @starkware-libs/anystark-core.
async function resolveDeployClassHashForChain(chain) {
  const core = await loadCoreResolver();
  return resolveSponsoredDeployClassHash(chain, core.CHAIN_IDS, core.resolveDeployClassHash);
}

// Render the per-call selector mapping (fix: name->selector echo) as reviewable
// lines. Kept separate from I/O so tests target describeSelectorMapping directly.
function selectorMappingLines(calls) {
  const mapping = describeSelectorMapping(calls);
  const lines = ["Selector mapping (verify each function name is spelled correctly):"];
  for (const entry of mapping) {
    lines.push(`  ${entry.address}`);
    if (entry.functions.length === 0) {
      lines.push("    (any selector)");
    } else {
      for (const fn of entry.functions) {
        lines.push(`    ${fn.functionName} -> ${fn.selector}`);
      }
    }
  }
  return lines;
}

// Validate, then print the selector mapping + any warnings (stderr, so a stdout
// redirect stays clean), then the one-liner, an optional indented form, and the
// next-steps block (stdout). Validation runs first so a rejected policy exits before
// we print anything that looks paste-ready.
async function emitPolicyOutput(policy, { pretty, calls }) {
  const policyString = serializePolicy(policy);
  const limited = Boolean(policy.rateLimit || policy.globalCap);
  await validateThroughRealParser(policyString, { limited });

  if (calls.length > 0) {
    for (const line of selectorMappingLines(calls)) {
      console.error(line);
    }
    console.error("");
  }

  const warnings = policyWarnings(policy);
  for (const warning of warnings) {
    console.warn(`WARNING: ${warning}`);
  }
  if (warnings.length > 0) {
    console.warn("");
  }

  console.log("PAYMASTER_POLICY (paste this single line into your deployment env):");
  console.log("");
  console.log(policyString);
  console.log("");

  if (pretty) {
    console.log("Human-readable policy (for review only; set the one-line form above, not this):");
    console.log("");
    console.log(JSON.stringify(policy, null, 2));
    console.log("");
  }

  console.log("Next steps:");
  console.log("  1. Set PAYMASTER_POLICY to the one-line string above in your deployment");
  console.log("     platform's environment variables (see the Deploy section of the README).");
  if (limited) {
    console.log(
      "  2. This policy sets a rateLimit/globalCap, so production also requires a durable store:",
    );
    console.log(
      "     set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (see the Security section).",
    );
  }
}

async function runFlagMode(argv) {
  const options = parseCliArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const deployClassHash = await resolveDeployClassHashForChain(options.chain);
  const policy = buildPolicy(options, deployClassHash);

  // FAIL CLOSED: refuse to emit a paste-ready string for a dangerous policy unless
  // the owner opted in with the matching flag. Exiting non-zero here (vs a stderr
  // warning + exit 0) stops a scripted `... > policy.env` from capturing a broad or
  // unbounded policy while the warning scrolls past unseen.
  const unacknowledged = unacknowledgedConditions(policy, options);
  if (unacknowledged.length > 0) {
    throw new Error(unacknowledged.map((condition) => condition.message).join("\n\n"));
  }

  await emitPolicyOutput(policy, { pretty: options.pretty, calls: options.calls });
}

// Linear readline wizard that assembles the same options object the flag parser
// produces, then reuses buildPolicy/emitPolicyOutput. Deliberately thin: all logic
// lives in the pure core so this wrapper needs no automated tests.
async function runInteractive() {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question) =>
    new Promise((resolve) => readline.question(question, (answer) => resolve(answer.trim())));
  const askYesNo = async (question) => /^y(es)?$/i.test(await ask(question));

  try {
    const options = createDefaultOptions();

    console.log("Paymaster policy generator (interactive). Press Enter to accept a default.\n");

    for (;;) {
      const address = await ask("Contract address to allow (blank to finish): ");
      if (address === "") break;
      const functionsAnswer = await ask(
        "  Function names on it, comma-separated (blank = allow any selector): ",
      );
      const functions = functionsAnswer
        .split(",")
        .map((functionName) => functionName.trim())
        .filter((functionName) => functionName !== "");
      options.calls.push({ to: address, functions });
    }

    const chainAnswer = await ask("Chain for the AnyStark deploy class hash [sepolia]: ");
    if (chainAnswer !== "") {
      options.chain = chainAnswer;
    }

    const deployClassHash = await resolveDeployClassHashForChain(options.chain);
    console.log(
      `The AnyStark account class hash for ${options.chain} (${deployClassHash}) is sponsored automatically; there is no option to change it.`,
    );

    const rateLimitAnswer = await ask(
      "Per-user rate limit as maxPerAddress/windowSec (count/seconds, e.g. 20/3600, blank for none): ",
    );
    if (rateLimitAnswer !== "") {
      options.rateLimit = parseRateLimit(rateLimitAnswer);
    }

    const globalCapAnswer = await ask(
      "Global budget cap as maxPerWindow/windowSec (count/seconds, e.g. 5000/3600, blank for none): ",
    );
    if (globalCapAnswer !== "") {
      options.globalCap = parseGlobalCap(globalCapAnswer);
    }

    const policy = buildPolicy(options, deployClassHash);

    // Per-condition confirmation, mirroring the flag mode's fail-closed gate. Default
    // (blank / anything but yes) aborts so a broad or unbounded policy is never
    // emitted without a deliberate "yes".
    for (const condition of dangerousConditions(policy)) {
      const confirmed = await askYesNo(`WARNING: ${condition.message}\n  Proceed anyway? [y/N]: `);
      if (!confirmed) {
        throw new Error("aborted: dangerous policy not confirmed");
      }
    }

    const pretty = await askYesNo("Also print indented JSON for review? [y/N]: ");

    console.log("");
    await emitPolicyOutput(policy, { pretty, calls: options.calls });
  } finally {
    readline.close();
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    if (process.stdin.isTTY) {
      await runInteractive();
    } else {
      // No flags and no TTY to run the wizard: there is nothing to generate. Print
      // usage to stderr and fail rather than emit an empty-allowlist policy.
      console.error(USAGE);
      process.exit(1);
    }
    return;
  }
  await runFlagMode(argv);
}

// True when this file is the entry point, whether invoked directly
// (node generate_policy.mjs) or through the anystark-paymaster-policy bin symlink. Node
// realpaths import.meta.url but leaves process.argv[1] as the symlink path, so a raw
// URL comparison would be false via the bin and the CLI would silently do nothing.
// Comparing the realpath of process.argv[1] against this module's path holds in both
// cases, and stays false when the module is merely imported (e.g. by the unit tests).
function isEntryPoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((error) => {
    console.error(`\nerror: ${error.message}`);
    process.exit(1);
  });
}
