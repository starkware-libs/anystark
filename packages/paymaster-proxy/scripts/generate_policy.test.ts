import { describe, expect, it } from "vitest";
import {
  buildPolicy,
  canonicalizeFelt,
  computeSelector,
  createDefaultOptions,
  dangerousConditions,
  describeSelectorMapping,
  parseCallSpec,
  parseCliArgs,
  parseGlobalCap,
  parseRateLimit,
  policyWarnings,
  resolveSponsoredDeployClassHash,
  serializePolicy,
  unacknowledgedConditions,
} from "./generate_policy.mjs";
import { configFromEnv } from "../src/config";
import { checkBuildTransaction, checkExecuteTransaction, normalizeFelt } from "../src/policy";
// The generator's mandatory sponsored class hash is the REAL pinned AnyStark deploy hash,
// resolved via @starkware-libs/anystark-core. Imported TS-to-TS from core/src (config.ts is pure
// constants, key_to_address.ts imports only starknet) so this needs no built dist.
import { CHAIN_IDS } from "../../core/src/config";
import { resolveDeployClassHash } from "../../core/src/key_to_address";

// Lives next to the .mjs (not under src/) so tsc's src-only typecheck never has to
// resolve the untyped .mjs import; vitest still discovers and runs it. The round-trip
// test below imports the REAL parser from ../src/config TS-to-TS, which is clean.

// A known sn_keccak vector: selector("transfer"), zero-padded to 32 bytes.
const TRANSFER_SELECTOR = "0x0083afd3f4caedc6eebf44246fe54e38c95e3179a5ec9ea81740eca5b482d12e";
// selector("approve"), zero-padded to 32 bytes.
const APPROVE_SELECTOR = "0x0219209e083275171774dab1df80982e9df2096516f06319c5c6d71ae0a8480c";
// A representative already-64-hex contract address.
const TOKEN_ADDRESS = "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7";
// The SAME token address as an UNPADDED felt (leading zero dropped): what a real
// request carries, and what the runtime's normalizeFelt reduces both sides to.
const TOKEN_ADDRESS_UNPADDED = "0x49d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7";
// selector("transfer") UNPADDED (leading zeros dropped).
const TRANSFER_SELECTOR_UNPADDED =
  "0x83afd3f4caedc6eebf44246fe54e38c95e3179a5ec9ea81740eca5b482d12e";
// Synthetic deploy class hash injected as the default so the "default applied" path
// is exercised without depending on @starkware-libs/anystark-core being built.
const SYNTHETIC_DEFAULT_CLASS_HASH = "0x0123456789abcdef";
const SYNTHETIC_DEFAULT_CLASS_HASH_CANONICAL =
  "0x0000000000000000000000000000000000000000000000000123456789abcdef";
// The pinned AnyStark sol_account `deploy` class hash for sepolia, resolved from
// @starkware-libs/anystark-core's SOL_ACCOUNT_CLASS_HASHES via resolveDeployClassHash - core's single
// source of truth. This is what the generator sponsors by default, always. It is already a
// 64-hex-digit felt, so buildPolicy's canonicalization emits it unchanged.
const SEPOLIA_DEPLOY_CLASS_HASH = resolveDeployClassHash({ chainId: CHAIN_IDS.sepolia });

describe("computeSelector", () => {
  it("hashes a function name to the known sn_keccak vector", () => {
    expect(computeSelector("transfer")).toBe(TRANSFER_SELECTOR);
  });

  it("preserves (canonicalizes) an already-0x selector felt", () => {
    // Unpadded input canonicalizes to the padded form...
    expect(
      computeSelector("0x83afd3f4caedc6eebf44246fe54e38c95e3179a5ec9ea81740eca5b482d12e"),
    ).toBe(TRANSFER_SELECTOR);
    // ...and the padded form round-trips to itself.
    expect(computeSelector(TRANSFER_SELECTOR)).toBe(TRANSFER_SELECTOR);
  });

  it("throws on a malformed felt", () => {
    expect(() => computeSelector("0xZZ")).toThrow(/0x-prefixed hex felt/);
  });
});

describe("canonicalizeFelt", () => {
  it("rejects a malformed address", () => {
    expect(() => canonicalizeFelt("0xnothex", "call address")).toThrow(
      /call address must be a 0x-prefixed hex felt/,
    );
  });

  it("rejects an out-of-range felt", () => {
    const aboveFieldPrime = "0x" + (2n ** 251n + 17n * 2n ** 192n + 2n).toString(16);
    expect(() => canonicalizeFelt(aboveFieldPrime, "class hash")).toThrow(/out of felt range/);
  });
});

describe("parseRateLimit / parseGlobalCap", () => {
  it("parses a rate limit spec", () => {
    expect(parseRateLimit("20/3600")).toEqual({ maxPerAddress: 20, windowSec: 3600 });
  });

  it("parses a global cap spec", () => {
    expect(parseGlobalCap("5000/3600")).toEqual({ maxPerWindow: 5000, windowSec: 3600 });
  });

  it("throws on a malformed rate limit spec", () => {
    expect(() => parseRateLimit("20-3600")).toThrow(/two positive integers/);
    expect(() => parseRateLimit("0/3600")).toThrow(/two positive integers/);
    expect(() => parseRateLimit("20/3600/1")).toThrow(/two positive integers/);
  });
});

describe("parseCallSpec", () => {
  it("parses an address with a function list", () => {
    expect(parseCallSpec(`${TOKEN_ADDRESS}:transfer,approve`)).toEqual({
      to: TOKEN_ADDRESS,
      functions: ["transfer", "approve"],
    });
  });

  it("parses a bare address as an any-selector entry", () => {
    expect(parseCallSpec(TOKEN_ADDRESS)).toEqual({ to: TOKEN_ADDRESS, functions: [] });
  });

  it("throws on a trailing colon with no function names (no silent any-selector)", () => {
    // Each of these previously filtered to an empty list and silently widened to
    // ANY selector. They must now be hard errors.
    expect(() => parseCallSpec(`${TOKEN_ADDRESS}:`)).toThrow(/trailing ":" with no function names/);
    expect(() => parseCallSpec(`${TOKEN_ADDRESS}:,`)).toThrow(
      /trailing ":" with no function names/,
    );
    expect(() => parseCallSpec(`${TOKEN_ADDRESS}:,,`)).toThrow(
      /trailing ":" with no function names/,
    );
  });
});

describe("parseCliArgs", () => {
  it("throws on an unknown flag", () => {
    expect(() => parseCliArgs(["--frobnicate"])).toThrow(/unknown flag: --frobnicate/);
  });

  it("throws when a flag is missing its value", () => {
    expect(() => parseCliArgs(["--call"])).toThrow(/--call requires a value/);
  });

  it("rejects the removed --class-hash / --no-class-hashes flags as unknown flags", () => {
    // Sponsoring the AnyStark account deploy class is mandatory (the generator always
    // includes it), so there is no knob for it: the removed override flags are now unknown.
    expect(() => parseCliArgs(["--class-hash", "0x1"])).toThrow(/unknown flag: --class-hash/);
    expect(() => parseCliArgs(["--no-class-hashes"])).toThrow(/unknown flag: --no-class-hashes/);
  });

  it("parses the acknowledgment flags", () => {
    const options = parseCliArgs([
      "--call",
      TOKEN_ADDRESS,
      "--allow-any-selector",
      "--allow-unbounded-budget",
    ]);
    expect(options.allowAnySelector).toBe(true);
    expect(options.allowUnboundedBudget).toBe(true);
  });
});

describe("createDefaultOptions", () => {
  it("defaults both acknowledgment flags to false and omits presentation-only fields", () => {
    const options = createDefaultOptions();
    expect(options.allowAnySelector).toBe(false);
    expect(options.allowUnboundedBudget).toBe(false);
    expect("help" in options).toBe(false);
    expect("pretty" in options).toBe(false);
  });
});

describe("buildPolicy", () => {
  it("builds the exact expected policy from a full flag set, using the default class hash", () => {
    const options = parseCliArgs([
      "--call",
      `${TOKEN_ADDRESS}:transfer,approve`,
      "--rate-limit",
      "20/3600",
      "--global-cap",
      "5000/3600",
      "--chain",
      "sepolia",
      "--pretty",
    ]);
    const policy = buildPolicy(options, SYNTHETIC_DEFAULT_CLASS_HASH);
    expect(policy).toEqual({
      allowedCalls: [{ to: TOKEN_ADDRESS, selectors: [TRANSFER_SELECTOR, APPROVE_SELECTOR] }],
      sponsoredClassHashes: [SYNTHETIC_DEFAULT_CLASS_HASH_CANONICAL],
      rateLimit: { maxPerAddress: 20, windowSec: 3600 },
      globalCap: { maxPerWindow: 5000, windowSec: 3600 },
    });
  });

  it("emits a call entry with no selectors for --call <address> alone and warns", () => {
    const options = parseCliArgs(["--call", TOKEN_ADDRESS]);
    const policy = buildPolicy(options, SYNTHETIC_DEFAULT_CLASS_HASH);
    expect(policy.allowedCalls).toEqual([{ to: TOKEN_ADDRESS }]);
    expect(policy.allowedCalls[0].selectors).toBeUndefined();
    const warnings = policyWarnings(policy);
    expect(warnings.some((warning) => warning.includes("ANY selector"))).toBe(true);
  });

  it("always sponsors exactly the resolved deploy class hash (no override, no opt-out)", () => {
    // Sponsoring the AnyStark account class is mandatory: sponsoredClassHashes is always a
    // single-entry list holding the resolved deploy hash, regardless of the calls/limits.
    const options = parseCliArgs(["--call", `${TOKEN_ADDRESS}:transfer`]);
    expect(buildPolicy(options, SEPOLIA_DEPLOY_CLASS_HASH).sponsoredClassHashes).toEqual([
      SEPOLIA_DEPLOY_CLASS_HASH,
    ]);
  });

  it("throws on a malformed call address", () => {
    const options = parseCliArgs(["--call", "0xZZ:transfer"]);
    expect(() => buildPolicy(options, SYNTHETIC_DEFAULT_CLASS_HASH)).toThrow(
      /call address must be a 0x-prefixed hex felt/,
    );
  });

  it("warns when no budget limit is set", () => {
    const options = parseCliArgs(["--call", `${TOKEN_ADDRESS}:transfer`]);
    const policy = buildPolicy(options, SYNTHETIC_DEFAULT_CLASS_HASH);
    const warnings = policyWarnings(policy);
    expect(warnings.some((warning) => warning.includes("UNBOUNDED"))).toBe(true);
  });
});

// Sponsoring the AnyStark account deploy class is mandatory: the generator always
// sponsors the pinned deploy class hash for the chosen chain and offers no override. These exercise that resolution against the
// REAL @starkware-libs/anystark-core resolver: the default chain yields the pinned sepolia hash, and an
// unsupported chain yields the actionable error rather than a manual-override escape.
describe("resolveSponsoredDeployClassHash (mandatory AnyStark account sponsorship)", () => {
  it("resolves the pinned sepolia deploy class hash by default, and it flows into the policy", () => {
    const deployClassHash = resolveSponsoredDeployClassHash(
      createDefaultOptions().chain,
      CHAIN_IDS,
      resolveDeployClassHash,
    );
    expect(deployClassHash).toBe(SEPOLIA_DEPLOY_CLASS_HASH);
    const policy = buildPolicy(
      parseCliArgs(["--call", `${TOKEN_ADDRESS}:transfer`]),
      deployClassHash,
    );
    expect(policy.sponsoredClassHashes).toEqual([SEPOLIA_DEPLOY_CLASS_HASH]);
  });

  it("resolves by chain NAME (sepolia) and by its raw chainId felt identically", () => {
    expect(resolveSponsoredDeployClassHash("sepolia", CHAIN_IDS, resolveDeployClassHash)).toBe(
      resolveSponsoredDeployClassHash(CHAIN_IDS.sepolia, CHAIN_IDS, resolveDeployClassHash),
    );
  });

  it("throws the actionable 'not supported by AnyStark' error for a chain with no pinned hash", () => {
    expect(() =>
      resolveSponsoredDeployClassHash("0xdead", CHAIN_IDS, resolveDeployClassHash),
    ).toThrow(/"0xdead" is not supported by AnyStark yet/);
    expect(() =>
      resolveSponsoredDeployClassHash("0xdead", CHAIN_IDS, resolveDeployClassHash),
    ).toThrow(/SOL_ACCOUNT_CLASS_HASHES/);
  });
});

// Regression coverage for the duplicate-target bug: compileAllowlist in the proxy
// keys on the canonical address and keeps only the LAST entry per address, so the
// generator must merge duplicates itself rather than emit several entries.
describe("buildPolicy duplicate --call target merging", () => {
  it("merges function-list entries for one address into a deduped union", () => {
    const options = parseCliArgs([
      "--call",
      `${TOKEN_ADDRESS}:transfer`,
      // Repeats `transfer` (must dedupe) and adds `approve` (union).
      "--call",
      `${TOKEN_ADDRESS}:approve,transfer`,
    ]);
    const policy = buildPolicy(options, SYNTHETIC_DEFAULT_CLASS_HASH);
    expect(policy.allowedCalls).toEqual([
      { to: TOKEN_ADDRESS, selectors: [TRANSFER_SELECTOR, APPROVE_SELECTOR] },
    ]);
  });

  it("merges across differently-padded spellings of the same address", () => {
    const options = parseCliArgs([
      "--call",
      `${TOKEN_ADDRESS}:transfer`,
      "--call",
      `${TOKEN_ADDRESS_UNPADDED}:approve`,
    ]);
    const policy = buildPolicy(options, SYNTHETIC_DEFAULT_CLASS_HASH);
    expect(policy.allowedCalls).toEqual([
      { to: TOKEN_ADDRESS, selectors: [TRANSFER_SELECTOR, APPROVE_SELECTOR] },
    ]);
  });

  it("collapses repeated bare (any-selector) entries into one", () => {
    const options = parseCliArgs(["--call", TOKEN_ADDRESS, "--call", TOKEN_ADDRESS_UNPADDED]);
    const policy = buildPolicy(options, SYNTHETIC_DEFAULT_CLASS_HASH);
    expect(policy.allowedCalls).toEqual([{ to: TOKEN_ADDRESS }]);
  });

  it("hard-errors when an address is given both bare and with a function list", () => {
    const options = parseCliArgs(["--call", TOKEN_ADDRESS, "--call", `${TOKEN_ADDRESS}:transfer`]);
    expect(() => buildPolicy(options, SYNTHETIC_DEFAULT_CLASS_HASH)).toThrow(
      /both as a bare any-selector entry .* and with a function list/,
    );
  });

  it("produces a merged policy the REAL parser accepts (union preserved end-to-end)", () => {
    const options = parseCliArgs([
      "--call",
      `${TOKEN_ADDRESS}:transfer`,
      "--call",
      `${TOKEN_ADDRESS}:approve`,
    ]);
    const policyString = serializePolicy(buildPolicy(options, SYNTHETIC_DEFAULT_CLASS_HASH));
    const config = configFromEnv({ PAYMASTER_API_KEY: "test-key", PAYMASTER_POLICY: policyString });
    expect(config.policy.allowedCalls).toHaveLength(1);
    expect(config.policy.allowedCalls[0].selectors).toEqual([TRANSFER_SELECTOR, APPROVE_SELECTOR]);
  });
});

describe("dangerousConditions / unacknowledgedConditions (fail-closed gate)", () => {
  it("flags a bare any-selector entry, naming the address and the flag", () => {
    const policy = buildPolicy(
      parseCliArgs(["--call", TOKEN_ADDRESS]),
      SYNTHETIC_DEFAULT_CLASS_HASH,
    );
    const conditions = dangerousConditions(policy);
    const anySelector = conditions.find((condition) => condition.kind === "anySelector");
    expect(anySelector).toBeDefined();
    expect(anySelector?.flag).toBe("--allow-any-selector");
    expect(anySelector?.message).toContain(TOKEN_ADDRESS);
  });

  it("flags an unbounded budget when neither rateLimit nor globalCap is set", () => {
    const policy = buildPolicy(
      parseCliArgs(["--call", `${TOKEN_ADDRESS}:transfer`]),
      SYNTHETIC_DEFAULT_CLASS_HASH,
    );
    const conditions = dangerousConditions(policy);
    expect(conditions.some((condition) => condition.kind === "unboundedBudget")).toBe(true);
    expect(conditions.find((condition) => condition.kind === "unboundedBudget")?.flag).toBe(
      "--allow-unbounded-budget",
    );
  });

  it("does not flag an unbounded budget once a rateLimit is set", () => {
    const policy = buildPolicy(
      parseCliArgs(["--call", `${TOKEN_ADDRESS}:transfer`, "--rate-limit", "20/3600"]),
      SYNTHETIC_DEFAULT_CLASS_HASH,
    );
    expect(dangerousConditions(policy).some((c) => c.kind === "unboundedBudget")).toBe(false);
  });

  it("reports unacknowledged conditions absent the ack flags (would exit 1)", () => {
    // Bare call + no budget: both dangerous conditions, neither acknowledged.
    const options = parseCliArgs(["--call", TOKEN_ADDRESS]);
    const policy = buildPolicy(options, SYNTHETIC_DEFAULT_CLASS_HASH);
    const unmet = unacknowledgedConditions(policy, options);
    expect(unmet.map((condition) => condition.kind).sort()).toEqual([
      "anySelector",
      "unboundedBudget",
    ]);
  });

  it("reports no unacknowledged conditions once both ack flags are present (would emit)", () => {
    const options = parseCliArgs([
      "--call",
      TOKEN_ADDRESS,
      "--allow-any-selector",
      "--allow-unbounded-budget",
    ]);
    const policy = buildPolicy(options, SYNTHETIC_DEFAULT_CLASS_HASH);
    expect(unacknowledgedConditions(policy, options)).toEqual([]);
    // The warnings are still produced (emitted once opted in).
    expect(policyWarnings(policy).length).toBeGreaterThan(0);
  });
});

describe("describeSelectorMapping (name -> selector echo)", () => {
  it("maps each function name to its canonical selector under the canonical address", () => {
    const mapping = describeSelectorMapping([{ to: TOKEN_ADDRESS, functions: ["transfer"] }]);
    expect(mapping).toEqual([
      {
        address: TOKEN_ADDRESS,
        functions: [{ functionName: "transfer", selector: TRANSFER_SELECTOR }],
      },
    ]);
  });

  it("echoes a raw-felt function input as its canonical felt", () => {
    const mapping = describeSelectorMapping([
      { to: TOKEN_ADDRESS_UNPADDED, functions: [TRANSFER_SELECTOR_UNPADDED] },
    ]);
    expect(mapping).toEqual([
      {
        address: TOKEN_ADDRESS,
        functions: [{ functionName: TRANSFER_SELECTOR_UNPADDED, selector: TRANSFER_SELECTOR }],
      },
    ]);
  });

  it("surfaces a typo as a different selector than the intended function", () => {
    const [correct] = describeSelectorMapping([{ to: TOKEN_ADDRESS, functions: ["transfer"] }]);
    const [typo] = describeSelectorMapping([{ to: TOKEN_ADDRESS, functions: ["trasnfer"] }]);
    expect(typo.functions[0].selector).not.toBe(correct.functions[0].selector);
  });

  it("carries no functions for a bare (any-selector) entry", () => {
    expect(describeSelectorMapping([{ to: TOKEN_ADDRESS, functions: [] }])).toEqual([
      { address: TOKEN_ADDRESS, functions: [] },
    ]);
  });
});

describe("round-trip through the real proxy parser", () => {
  it("produces a string accepted by the real configFromEnv", () => {
    const options = parseCliArgs([
      "--call",
      `${TOKEN_ADDRESS}:transfer,approve`,
      "--rate-limit",
      "20/3600",
      "--global-cap",
      "5000/3600",
    ]);
    const policy = buildPolicy(options, SYNTHETIC_DEFAULT_CLASS_HASH);
    const policyString = serializePolicy(policy);

    const config = configFromEnv({
      PAYMASTER_API_KEY: "test-key",
      PAYMASTER_POLICY: policyString,
      // A durable store must appear present, else configFromEnv fail-closes on the
      // configured rateLimit/globalCap (a deployment concern, not a policy defect).
      UPSTASH_REDIS_REST_URL: "https://round-trip-test.invalid",
      UPSTASH_REDIS_REST_TOKEN: "round-trip-test",
    });
    expect(config.policy.allowedCalls[0].to).toBe(TOKEN_ADDRESS);
    expect(config.policy.sponsoredClassHashes).toEqual([SYNTHETIC_DEFAULT_CLASS_HASH_CANONICAL]);
  });

  it("makes the generated selectors pass the real allowlist check", () => {
    const options = parseCliArgs(["--call", `${TOKEN_ADDRESS}:transfer`]);
    const policyString = serializePolicy(buildPolicy(options, SYNTHETIC_DEFAULT_CLASS_HASH));
    const config = configFromEnv({ PAYMASTER_API_KEY: "test-key", PAYMASTER_POLICY: policyString });
    expect(config.policy.allowedCalls[0].selectors).toEqual([TRANSFER_SELECTOR]);
  });
});

// The generator zero-pads every felt; a real request carries UNPADDED felts. This
// pins that the runtime's normalizeFelt reduces both sides identically, so a policy
// straight out of the generator actually matches at enforcement time on BOTH the
// build and execute paths (execute is the call that spends money).
describe("generated policy matches at enforcement time (unpadded request felts)", () => {
  const options = parseCliArgs(["--call", `${TOKEN_ADDRESS}:transfer`]);
  const policyString = serializePolicy(buildPolicy(options, SYNTHETIC_DEFAULT_CLASS_HASH));
  const { policy } = configFromEnv({
    PAYMASTER_API_KEY: "test-key",
    PAYMASTER_POLICY: policyString,
  });

  const buildTx = (to: string, selector: string) => ({
    transaction: { type: "invoke", invoke: { user_address: "0x1234", calls: [{ to, selector }] } },
  });
  const executeTx = (To: string, Selector: string) => ({
    transaction: {
      type: "invoke",
      invoke: {
        user_address: "0x1234",
        typed_data: {
          domain: { version: "2", revision: "1" },
          message: { Calls: [{ To, Selector }] },
        },
      },
    },
  });

  it("sanity: unpadded felts reduce to the padded generated felts", () => {
    expect(normalizeFelt(TOKEN_ADDRESS_UNPADDED)).toBe(normalizeFelt(TOKEN_ADDRESS));
    expect(normalizeFelt(TRANSFER_SELECTOR_UNPADDED)).toBe(normalizeFelt(TRANSFER_SELECTOR));
  });

  it("allows a build request whose to/selector are unpadded", () => {
    const decision = checkBuildTransaction(
      buildTx(TOKEN_ADDRESS_UNPADDED, TRANSFER_SELECTOR_UNPADDED),
      policy,
    );
    expect(decision.ok).toBe(true);
  });

  it("allows an execute request whose To/Selector are unpadded", () => {
    const decision = checkExecuteTransaction(
      executeTx(TOKEN_ADDRESS_UNPADDED, TRANSFER_SELECTOR_UNPADDED),
      policy,
    );
    expect(decision.ok).toBe(true);
  });

  it("rejects a non-allowlisted selector on the same contract (build and execute)", () => {
    const build = checkBuildTransaction(buildTx(TOKEN_ADDRESS_UNPADDED, APPROVE_SELECTOR), policy);
    expect(build.ok).toBe(false);
    expect(build.reason).toMatch(/selector/);
    const execute = checkExecuteTransaction(
      executeTx(TOKEN_ADDRESS_UNPADDED, APPROVE_SELECTOR),
      policy,
    );
    expect(execute.ok).toBe(false);
    expect(execute.reason).toMatch(/selector/);
  });
});
