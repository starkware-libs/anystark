// Sponsorship policy: which SNIP-29 requests this proxy is willing to forward to
// the upstream paymaster with the secret sponsor key attached.
//
// The proxy only sponsors what the policy explicitly allows, so a leaked frontend
// cannot drain the dApp's gas budget on arbitrary calls. The SAME allowlist is
// enforced on BOTH `paymaster_buildTransaction` and `paymaster_executeTransaction`
// — the latter is the call that actually spends money.

/**
 * Thrown by {@link normalizeFelt} when its input is not a parseable felt.
 * The handler catches this and maps it to a JSON-RPC INVALID_PARAMS (-32602)
 * error instead of letting a raw `BigInt(...)` SyntaxError bubble up as a 500.
 */
export class InvalidFeltError extends Error {
  constructor(public readonly value: unknown) {
    super(`invalid felt: ${typeof value === "string" ? JSON.stringify(value) : String(value)}`);
    this.name = "InvalidFeltError";
  }
}

/**
 * Thrown by {@link extractTargets} when `invoke.user_address` and
 * `deployment.address` are both present but name different accounts. The handler
 * maps it to INVALID_PARAMS.
 */
export class ConflictingAccountAddressError extends Error {
  constructor(
    public readonly userAddress: string,
    public readonly deploymentAddress: string,
  ) {
    super(
      `conflicting account address: invoke.user_address (${JSON.stringify(userAddress)}) and ` +
        `deployment.address (${JSON.stringify(deploymentAddress)}) must be the same account`,
    );
    this.name = "ConflictingAccountAddressError";
  }
}

/**
 * Thrown by {@link extractTargets} on the execute path when the signed
 * OutsideExecution form cannot be determined unambiguously from the typed data.
 * The handler maps it to INVALID_PARAMS.
 */
export class InvalidOutsideExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidOutsideExecutionError";
  }
}

/**
 * The Starknet field prime: 2^251 + 17·2^192 + 1. A valid felt is in `[0, P)`.
 * Anything `>= P` is not a representable field element and is rejected as
 * malformed rather than silently canonicalized (defense-in-depth on this
 * fund-critical allowlist boundary).
 */
const FIELD_PRIME = 2n ** 251n + 17n * 2n ** 192n + 1n;

/** Canonical felt form: lowercase `0x` hex with no leading zeros (so `0x04` == `0x4`). */
export function normalizeFelt(value: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new InvalidFeltError(value);
  }
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new InvalidFeltError(value);
  }
  // Reject negatives and out-of-field values. Note BigInt() also accepts decimal,
  // 0o/0b and whitespace-padded forms; matching stays safe because both the
  // allowlist and request sides normalize identically, and any non-felt-range
  // value is rejected here.
  if (parsed < 0n || parsed >= FIELD_PRIME) throw new InvalidFeltError(value);
  return "0x" + parsed.toString(16);
}

/** A call the dApp is willing to sponsor: a target contract and, optionally, a selector allowlist. */
export interface AllowedCall {
  /** Contract address (`to`). */
  to: string;
  /** Allowed entry-point selectors (felt). Omit to allow any selector on `to`. */
  selectors?: string[];
}

/** Fee mode the proxy forces on forwarded requests. Defaults to `{ mode: "sponsored" }`. */
export interface FeeMode {
  mode: "sponsored" | "default";
  gas_token?: string;
}

// NOTE: checkTransaction/extractTargets in THIS module read only `allowedCalls`,
// `sponsoredClassHashes`, and the `rateLimitKey`. The rate-limit / budget /
// fee-mode / tip fields below are consumed elsewhere in the stack: the handler
// enforces `rateLimit`, `globalCap`, `feeMode`, and `maxTip`, and config plus the
// handler consume `allowInMemoryStore` for the fail-closed durable-store guard.
export interface SponsorshipPolicy {
  /** Calls eligible for sponsorship. A call is allowed if its `to` matches and its selector is permitted. */
  allowedCalls: AllowedCall[];
  /** Class hashes whose counterfactual deployment may be sponsored. */
  sponsoredClassHashes: string[];
  /**
   * Per-account rate limit (keyed by the user/deploy address). Enforced by the
   * handler, which rejects a request that carries no account address.
   */
  rateLimit?: { maxPerAddress: number; windowSec: number };
  /**
   * Global budget cap across ALL addresses, enforced on a single shared counter.
   * Bounds total sponsored ops regardless of sybil address churn. Enforced by the
   * handler on both the build and execute paths.
   */
  globalCap?: { maxPerWindow: number; windowSec: number };
  /**
   * Fee mode forced onto forwarded requests. Client-supplied `fee_mode` is never
   * trusted. Defaults to `{ mode: "sponsored" }`. Applied by the handler.
   */
  feeMode?: FeeMode;
  /**
   * Optional max tip (u64). When set, a client tip is clamped to this value;
   * when unset (default), any client tip is stripped entirely. Applied by the
   * handler.
   */
  maxTip?: number;
  /**
   * Escape hatch for local/test only: permit the in-memory rate-limit store even
   * when `rateLimit`/`globalCap` are configured. In production this MUST be unset
   * (or false) so the handler/adapters FAIL CLOSED when a durable store is absent.
   * Consumed by config (deploy-time guard) and the handler (per-request guard).
   */
  allowInMemoryStore?: boolean;
}

/**
 * True if the policy configures any rate limit or budget cap. This is the
 * single "a limit is set" predicate shared by the fail-closed checks in
 * config (refuse to deploy) and the handler (refuse to sponsor) so the two
 * sites cannot drift.
 */
export function hasLimit(policy: SponsorshipPolicy): boolean {
  return Boolean(policy.rateLimit || policy.globalCap);
}

export interface PolicyDecision {
  ok: boolean;
  /** Address used for rate limiting (user_address or deployment.address), if found. */
  rateLimitKey?: string;
  reason?: string;
}

/** Normalized set of targets extracted from either a build or execute transaction. */
export interface ExtractedTargets {
  /** SNIP-29 transaction type (`invoke` | `deploy` | `deploy_and_invoke`). */
  type: string;
  /** Calls to validate against the allowlist. */
  calls: { to: string; selector: string }[];
  /** Class hash to validate against the sponsored allowlist (deploy paths). */
  classHash?: string;
  /** Address used to key the per-account rate limit. */
  rateLimitKey?: string;
}

const SUPPORTED_TYPES = new Set(["invoke", "deploy", "deploy_and_invoke"]);

// Each call source has exactly one casing, and extraction reads only that casing:
// a signed call may carry unsigned siblings in the other casing.
//   - build (invoke.calls) and execute V1 (message.calls): `to`/`selector`
//   - execute V2 (message.Calls): `To`/`Selector`
interface RawCall {
  to?: string;
  selector?: string;
  To?: string;
  Selector?: string;
}

interface RawTransaction {
  type?: string;
  invoke?: {
    user_address?: string;
    // buildTransaction shape
    calls?: RawCall[];
    // executeTransaction shape: signed SNIP-12 typed data
    typed_data?: {
      domain?: { version?: unknown; revision?: unknown };
      message?: { Calls?: RawCall[]; calls?: RawCall[] };
    };
  };
  deployment?: { address?: string; class_hash?: string };
}

/**
 * The SNIP-9 OutsideExecution form from the signed typed-data domain, as AVNU and
 * starknet.js build it: V1 is `{version: "1"}` with no `revision`, V2 is
 * `{version: "2", revision: "1"}`. AVNU executes V1 or V2 by `revision` alone, so
 * any other domain is rejected.
 */
function signedOutsideExecutionForm(domain: {
  version?: unknown;
  revision?: unknown;
}): "V1" | "V2" {
  const scalar = (value: unknown) =>
    typeof value === "string" || typeof value === "number" ? String(value) : undefined;
  const version = scalar(domain.version);
  if (version === "2" && scalar(domain.revision) === "1") return "V2";
  if (version === "1" && domain.revision === undefined) return "V1";
  throw new InvalidOutsideExecutionError(
    `unrecognized OutsideExecution typed-data domain: expected {version:"1"} or ` +
      `{version:"2",revision:"1"}, got {version:${JSON.stringify(domain.version)},` +
      `revision:${JSON.stringify(domain.revision)}}`,
  );
}

type CallFields = { to: keyof RawCall; selector: keyof RawCall };

const LOWERCASE_FIELDS: CallFields = { to: "to", selector: "selector" };

const SIGNED_CALLS: Record<"V1" | "V2", { key: "calls" | "Calls"; fields: CallFields }> = {
  V1: { key: "calls", fields: LOWERCASE_FIELDS },
  V2: { key: "Calls", fields: { to: "To", selector: "Selector" } },
};

function readCalls(rawCalls: RawCall[], fields: CallFields): { to: string; selector: string }[] {
  return rawCalls.map((call) => ({
    to: call[fields.to] ?? "",
    selector: call[fields.selector] ?? "",
  }));
}

/**
 * Reads the calls the transaction executes. On execute, the form comes from the
 * signed domain and never from which `message` key is present: keys that are not
 * in the signed type are not hashed, so a V1-signed message can carry an added
 * benign `Calls` array without invalidating its signature.
 */
function extractCalls(tx: RawTransaction, source: CallSource): { to: string; selector: string }[] {
  if (source === "build") {
    const calls = tx.invoke?.calls ?? [];
    if (!Array.isArray(calls)) throw new TypeError("transaction.invoke.calls is not an array");
    return readCalls(calls, LOWERCASE_FIELDS);
  }
  // A deploy carries no typed data and runs no calls.
  if (tx.type === "deploy") return [];

  const typedData = tx.invoke?.typed_data;
  const form = signedOutsideExecutionForm(typedData?.domain ?? {});
  const message = typedData?.message;
  if (message?.Calls !== undefined && message?.calls !== undefined) {
    throw new InvalidOutsideExecutionError(
      "typed_data.message carries both `Calls` (V2) and `calls` (V1)",
    );
  }
  const { key, fields } = SIGNED_CALLS[form];
  const rawCalls = message?.[key];
  if (!Array.isArray(rawCalls)) {
    throw new InvalidOutsideExecutionError(
      `typed_data domain is ${form} but message has no \`${key}\` array`,
    );
  }
  return readCalls(rawCalls, fields);
}

/**
 * The executing account address: `invoke.user_address` on `invoke`,
 * `deployment.address` on `deploy`. A `deploy_and_invoke` carries both, and they
 * must name the same account.
 */
function accountAddress(tx: RawTransaction): string | undefined {
  const userAddress = tx.invoke?.user_address;
  const deploymentAddress = tx.deployment?.address;
  if (tx.type === "invoke") return userAddress;
  if (tx.type === "deploy") return deploymentAddress;
  if (
    userAddress !== undefined &&
    deploymentAddress !== undefined &&
    normalizeFelt(userAddress) !== normalizeFelt(deploymentAddress)
  ) {
    throw new ConflictingAccountAddressError(userAddress, deploymentAddress);
  }
  return deploymentAddress ?? userAddress;
}

/**
 * Which RPC method the params came from, so {@link extractTargets} reads the
 * calls from the correct (and only the correct) location.
 *
 * - `build`:   calls live at `transaction.invoke.calls`.
 * - `execute`: calls live ONLY in the SIGNED typed data
 *              (`transaction.invoke.typed_data.message.Calls/calls`).
 */
export type CallSource = "build" | "execute";

/**
 * Extract the calls + class hash + rate-limit key from EITHER a
 * `paymaster_buildTransaction` or `paymaster_executeTransaction` params object.
 *
 * - build:   calls at `transaction.invoke.calls` (`to`/`selector`).
 * - execute: calls in the signed SNIP-12 typed data at
 *            `transaction.invoke.typed_data.message`: V2 `Calls` with
 *            `To`/`Selector`, or V1 `calls` with `to`/`selector`.
 * - both:    deploy class hash at `transaction.deployment.class_hash`.
 *
 * SECURITY: extraction is method-aware to prevent a confused-deputy bypass. For
 * `execute` the upstream paymaster runs exactly the calls inside the SIGNED
 * `typed_data.message`, so we read calls ONLY from there and IGNORE any
 * client-supplied `invoke.calls`. Otherwise a caller could attach a benign,
 * allowlisted `invoke.calls` array (which we would validate) while smuggling
 * malicious calls into the signed message (which would actually get sponsored).
 *
 * Returns `null` if there is no usable transaction object, and only the `type`
 * for an unsupported one. Throws {@link InvalidOutsideExecutionError} on ambiguous
 * typed data, and a `TypeError` when a build `invoke.calls` is not an array. On
 * `deploy_and_invoke` it compares `user_address` with `deployment.address` and
 * throws {@link ConflictingAccountAddressError} if they differ, or
 * {@link InvalidFeltError} if either is malformed.
 */
export function extractTargets(
  params: unknown,
  source: CallSource = "build",
): ExtractedTargets | null {
  const tx = (params as { transaction?: RawTransaction } | undefined)?.transaction;
  if (!tx || typeof tx.type !== "string") return null;
  if (!SUPPORTED_TYPES.has(tx.type)) return { type: tx.type, calls: [] };

  return {
    type: tx.type,
    calls: extractCalls(tx, source),
    classHash: tx.deployment?.class_hash,
    rateLimitKey: accountAddress(tx),
  };
}

/**
 * Reject a policy that lists the same target contract in more than one
 * `allowedCalls` entry. Two entries collide when their `to` values NORMALIZE to
 * the same felt (via {@link normalizeFelt}), so `0x04` and `0x4` count as
 * duplicates.
 *
 * FAIL-CLOSED, run at policy parse time. Without this guard, duplicate targets
 * are last-write-wins in {@link compileAllowlist}'s `Map`, which silently either
 * NARROWS the allowlist (a later selector list overwrites an earlier one, so
 * selectors the dApp expected to be sponsored are dropped) or BROADENS it (a
 * later bare entry overwrites a selector list, granting any-selector on the
 * target and opening the gas budget to drain). Rejecting up front guarantees
 * `compileAllowlist`'s `Map.set` is single-write per target for any policy built
 * via `configFromEnv`; hand-constructed policies (e.g. in tests) bypass this
 * guard and must uphold the invariant themselves.
 *
 * Throws a policy-config `Error` that (matching the sibling `validatePolicyFelts`
 * idiom) names both colliding entries by positional path and ORIGINAL spelling —
 * the duplicate and the first occurrence it collides with — so the operator can
 * grep their config. Both adapters parse the policy lazily (on the first
 * request), so the throw surfaces as a 500 on that first request with this
 * actionable message in the proxy's logs, not as a deploy-time crash; either way
 * the proxy refuses to operate on an ambiguous policy rather than guessing intent.
 *
 * Exported for direct unit tests; production callers go through `configFromEnv`.
 */
export function assertUniqueAllowedCallTargets(policy: SponsorshipPolicy): void {
  const firstIndexByTarget = new Map<string, number>();
  policy.allowedCalls.forEach((call, index) => {
    const normalizedTarget = normalizeFelt(call.to);
    const firstIndex = firstIndexByTarget.get(normalizedTarget);
    if (firstIndex !== undefined) {
      const firstCall = policy.allowedCalls[firstIndex];
      throw new Error(
        `PAYMASTER_POLICY has duplicate allowedCalls entries for the same address: ` +
          `allowedCalls[${index}].to (${JSON.stringify(call.to)}) duplicates ` +
          `allowedCalls[${firstIndex}].to (${JSON.stringify(firstCall.to)}): ` +
          `merge the selector lists into a single entry ` +
          `(or keep exactly one bare entry for any-selector)`,
      );
    }
    firstIndexByTarget.set(normalizedTarget, index);
  });
}

/** Normalized allowlist lookups derived from a policy: `to` -> permitted selectors (null = any). */
interface CompiledAllowlist {
  allowedTargets: Map<string, Set<string> | null>;
  allowedClasses: Set<string>;
}

// The allowlist is static across requests, so normalize it once per policy object
// rather than on every checkTransaction call (the hot sponsorship path). Keyed on
// the policy identity so a swapped-in policy recompiles automatically.
const compiledAllowlists = new WeakMap<SponsorshipPolicy, CompiledAllowlist>();

function compileAllowlist(policy: SponsorshipPolicy): CompiledAllowlist {
  const cached = compiledAllowlists.get(policy);
  if (cached) return cached;

  // Duplicate targets are rejected at parse time by assertUniqueAllowedCallTargets
  // (see configFromEnv), so each normalized `to` is written exactly once here.
  const allowedTargets = new Map<string, Set<string> | null>();
  for (const c of policy.allowedCalls) {
    allowedTargets.set(
      normalizeFelt(c.to),
      c.selectors ? new Set(c.selectors.map(normalizeFelt)) : null,
    );
  }
  const allowedClasses = new Set(policy.sponsoredClassHashes.map(normalizeFelt));

  const compiled = { allowedTargets, allowedClasses };
  compiledAllowlists.set(policy, compiled);
  return compiled;
}

/**
 * Validate extracted targets against the policy. Used by BOTH the build and
 * execute paths so the allowlist is enforced wherever calls are sponsored.
 *
 * Throws {@link InvalidFeltError} (caught by the handler -> INVALID_PARAMS) if any
 * address/selector/class-hash is a malformed felt.
 */
export function checkTransaction(
  targets: ExtractedTargets,
  policy: SponsorshipPolicy,
): PolicyDecision {
  const { type } = targets;

  if (!SUPPORTED_TYPES.has(type)) {
    return { ok: false, reason: `unsupported transaction type ${type}` };
  }

  const { allowedTargets, allowedClasses } = compileAllowlist(policy);

  // Deploy / deploy_and_invoke: the deployed class hash must be sponsored.
  if (type === "deploy" || type === "deploy_and_invoke") {
    const classHash = targets.classHash;
    if (!classHash || !allowedClasses.has(normalizeFelt(classHash))) {
      return {
        ok: false,
        reason: `class hash ${classHash ?? "<none>"} not in sponsored allowlist`,
      };
    }
  }

  // Invoke / deploy_and_invoke: every call must target an allowlisted (contract, selector).
  if (type === "invoke" || type === "deploy_and_invoke") {
    const calls = targets.calls;
    if (calls.length === 0) {
      return { ok: false, reason: "invoke has no calls" };
    }
    for (const call of calls) {
      if (!call.to || !call.selector) return { ok: false, reason: "call missing to/selector" };
      const to = normalizeFelt(call.to);
      if (!allowedTargets.has(to))
        return { ok: false, reason: `call target ${to} not allowlisted` };
      const selectors = allowedTargets.get(to);
      if (selectors && !selectors.has(normalizeFelt(call.selector))) {
        return { ok: false, reason: `selector ${call.selector} not allowed on ${to}` };
      }
    }
  }

  const rateLimitKey = targets.rateLimitKey;
  return { ok: true, rateLimitKey: rateLimitKey ? normalizeFelt(rateLimitKey) : undefined };
}

/**
 * Validate a `paymaster_buildTransaction` params object against the policy.
 * Thin wrapper over {@link extractTargets} + {@link checkTransaction} for the build path.
 */
export function checkBuildTransaction(params: unknown, policy: SponsorshipPolicy): PolicyDecision {
  const targets = extractTargets(params, "build");
  if (!targets) return { ok: false, reason: "missing transaction or transaction.type" };
  return checkTransaction(targets, policy);
}

/**
 * Validate a `paymaster_executeTransaction` params object against the policy.
 * Extracts calls from the signed SNIP-12 typed data and applies the same check.
 */
export function checkExecuteTransaction(
  params: unknown,
  policy: SponsorshipPolicy,
): PolicyDecision {
  const targets = extractTargets(params, "execute");
  if (!targets) return { ok: false, reason: "missing transaction or transaction.type" };
  return checkTransaction(targets, policy);
}
