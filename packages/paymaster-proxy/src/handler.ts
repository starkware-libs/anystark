// Framework-agnostic core of the SNIP-29 paymaster sponsorship proxy.
//
// A stateless JSON-RPC 2.0 pass-through that the SDK points
// `PaymasterRpc({ nodeUrl })` at instead of the upstream paymaster. It holds the
// secret upstream API key server-side, enforces a sponsorship policy on BOTH
// `paymaster_buildTransaction` AND `paymaster_executeTransaction` (the call that
// spends money), rate-limits per account, enforces a global budget cap, forces
// sponsored fee mode, and forwards everything else verbatim. The secret key must
// NEVER appear in any response.

import {
  checkTransaction,
  ConflictingAccountAddressError,
  extractTargets,
  hasLimit,
  InvalidFeltError,
  InvalidOutsideExecutionError,
  type PolicyDecision,
  type SponsorshipPolicy,
} from "./policy.js";

/** Header carrying the secret upstream paymaster API key. */
const PAYMASTER_KEY_HEADER = "x-paymaster-api-key";

/** Reserved rate-limit key for the single shared global budget counter. */
const GLOBAL_BUDGET_KEY = "__global__";

/** SNIP-29 methods this proxy is willing to forward. Anything else is rejected. */
const ALLOWED_METHODS = new Set([
  "paymaster_buildTransaction",
  "paymaster_executeTransaction",
  "paymaster_getSupportedTokens",
  "paymaster_isAvailable",
  "paymaster_trackingIdToLatestHash",
]);

/** Methods that sponsor calls and therefore require full policy + limit enforcement. */
const SPONSORING_METHODS = new Set(["paymaster_buildTransaction", "paymaster_executeTransaction"]);

/**
 * Per-key rate limiter. `hit` records one request against `key` within a sliding
 * `windowSec` window and returns the running count (including this request).
 */
export interface RateLimitStore {
  hit(key: string, windowSec: number): Promise<number>;
}

/**
 * Default in-memory rate limiter.
 *
 * NOTE: serverless/edge deployments run many short-lived isolates, so this store
 * does NOT share state across instances and effectively disables rate limiting
 * there. The handler FAILS CLOSED (refuses to sponsor) when a limit/cap is
 * configured but only this store is available — unless `policy.allowInMemoryStore`
 * is explicitly set (local/test). For production use `RedisRateLimitStore`.
 */
export class InMemoryRateLimitStore implements RateLimitStore {
  private hits = new Map<string, number[]>();

  async hit(key: string, windowSec: number): Promise<number> {
    const now = Date.now();
    const windowMs = windowSec * 1000;
    const cutoff = now - windowMs;
    const timestamps = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    timestamps.push(now);
    this.hits.set(key, timestamps);
    return timestamps.length;
  }
}

export interface ProxyConfig {
  /** Upstream SNIP-29 paymaster URL (AVNU hosted or self-hosted). */
  upstreamUrl: string;
  /** Secret upstream API key, injected as the `x-paymaster-api-key` header. */
  apiKey: string;
  /** Sponsorship policy enforced on build AND execute. */
  policy: SponsorshipPolicy;
  /** Rate-limit store. Defaults to an in-memory store (single-instance only). */
  store?: RateLimitStore;
}

// Minimal JSON-RPC 2.0 shapes.
interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

const JSON_RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

// Application-specific JSON-RPC error codes (in the implementation-defined range).
const APP_ERRORS = {
  POLICY_DENIED: -32010,
  RATE_LIMITED: -32011,
} as const;

function errorResult(id: unknown, error: JsonRpcError): { status: number; body: object } {
  return { status: 200, body: { jsonrpc: "2.0", id: id ?? null, error } };
}

/** True if `store` is the in-memory store (no shared state across isolates). */
function isInMemory(store: RateLimitStore): boolean {
  return store instanceof InMemoryRateLimitStore;
}

/**
 * Sanitize the `parameters` (USER_PARAMETERS) object of a build/execute request:
 * force the policy's fee mode and strip/clamp client tips. Client-supplied
 * `fee_mode` is NEVER trusted: a sponsorship-only proxy overrides any client
 * gas-token mode to sponsored (rather than rejecting). Tips are stripped by
 * default, or clamped to `policy.maxTip` if configured.
 */
function sanitizeUserParameters(parameters: unknown, policy: SponsorshipPolicy): unknown {
  // Override fee_mode wholesale (do not merge client fields like gas_token / tip).
  const feeMode = policy.feeMode ?? { mode: "sponsored" as const };
  const forced: Record<string, unknown> = { mode: feeMode.mode };
  if (feeMode.gas_token !== undefined) forced.gas_token = feeMode.gas_token;

  // Nothing usable from the client: still emit the forced fee_mode.
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    return { fee_mode: forced };
  }

  // Tip lives inside fee_mode (TIP_PRIORITY). Strip by default; clamp if maxTip set.
  if (policy.maxTip !== undefined) {
    const clientTip = (parameters as { fee_mode?: { tip?: unknown } }).fee_mode?.tip;
    if (typeof clientTip === "number") {
      forced.tip = Math.min(clientTip, policy.maxTip);
    } else if (
      clientTip &&
      typeof clientTip === "object" &&
      typeof (clientTip as { custom?: unknown }).custom === "number"
    ) {
      forced.tip = { custom: Math.min((clientTip as { custom: number }).custom, policy.maxTip) };
    }
    // Everything else is INTENTIONALLY DROPPED rather than clamped, including:
    // string priorities ("slow"/"normal"/"fast") and hex felt-string tips
    // (e.g. "0x1f4", the normal u64 wire format). Dropping is safe — it means no
    // tip is applied — but note the numeric clamp above therefore only bites on
    // already-numeric tips, not on raw wire-format hex tips.
  }

  const next: Record<string, unknown> = { ...(parameters as Record<string, unknown>) };
  next.fee_mode = forced;
  // Defensively strip any top-level tip the client may have smuggled in.
  delete next.tip;
  return next;
}

/**
 * Sanitize the `parameters` field of a build/execute JSON-RPC params object.
 * The RPC params are `{ transaction, parameters }`; only `parameters` carries
 * the fee mode / tip, so we rewrite that field and leave `transaction` intact.
 */
function sanitizeParams(params: unknown, policy: SponsorshipPolicy): unknown {
  if (!params || typeof params !== "object" || Array.isArray(params)) return params;
  const p = params as Record<string, unknown>;
  return { ...p, parameters: sanitizeUserParameters(p.parameters, policy) };
}

/**
 * Run the rate limit (per account) and global budget cap for a sponsoring
 * request. Returns a JSON-RPC error result if denied, or `null` to proceed.
 *
 * COUNTING SEMANTICS: limits count sponsoring RPC CALLS, not sponsored
 * transactions. A normal flow is `paymaster_buildTransaction` followed by
 * `paymaster_executeTransaction`, i.e. TWO calls against the same key and the
 * same global counter, so a single completed sponsorship consumes ~2 slots.
 * Counting also happens BEFORE the upstream forward, so a request the upstream
 * later rejects still consumes a slot. Choose `maxPerAddress` / `maxPerWindow`
 * accordingly (e.g. set maxPerAddress to ~2x the desired completed-flow count).
 *
 * With `rateLimit` set, a request that carries no account address is rejected as
 * INVALID_PARAMS before any counter moves.
 *
 * Fails CLOSED: if a limit/cap is configured but only the in-memory store is
 * available (without `allowInMemoryStore`), or if the store throws/is
 * unreachable, the request is DENIED rather than forwarded.
 */
async function enforceLimits(
  id: unknown,
  decision: PolicyDecision,
  policy: SponsorshipPolicy,
  store: RateLimitStore,
): Promise<{ status: number; body: object } | null> {
  // Fail closed: durable store required when any limit/cap is set.
  if (hasLimit(policy) && isInMemory(store) && !policy.allowInMemoryStore) {
    return errorResult(id, {
      code: APP_ERRORS.RATE_LIMITED,
      message:
        "Sponsorship denied: rate limiting requires a durable store " +
        "(set UPSTASH_REDIS_REST_URL/_TOKEN) or policy.allowInMemoryStore for local use",
    });
  }

  try {
    // Order matters: check the per-account limit BEFORE the global cap. The
    // global budget is a single shared, fund-critical counter; if we incremented
    // it first and the per-account check then denied, the global slot would be
    // permanently spent on a never-sponsored request, drifting the real budget
    // below its ceiling. By checking per-account first, a per-account denial
    // never touches the global counter.
    if (policy.rateLimit) {
      if (!decision.rateLimitKey) {
        return errorResult(id, {
          code: JSON_RPC_ERRORS.INVALID_PARAMS,
          message:
            "Invalid params: a per-account rate limit is configured but the request " +
            "carries no account address",
        });
      }
      const { maxPerAddress, windowSec } = policy.rateLimit;
      const count = await store.hit(decision.rateLimitKey, windowSec);
      if (count > maxPerAddress) {
        return errorResult(id, {
          code: APP_ERRORS.RATE_LIMITED,
          message: `Rate limit exceeded: max ${maxPerAddress} requests per ${windowSec}s per account`,
        });
      }
    }

    // Global budget cap: a single shared counter across ALL addresses.
    if (policy.globalCap) {
      const { maxPerWindow, windowSec } = policy.globalCap;
      const count = await store.hit(GLOBAL_BUDGET_KEY, windowSec);
      if (count > maxPerWindow) {
        return errorResult(id, {
          code: APP_ERRORS.RATE_LIMITED,
          message: `Global sponsorship budget exceeded: max ${maxPerWindow} ops per ${windowSec}s`,
        });
      }
    }
  } catch {
    // Store unreachable / error: fail closed, do not forward.
    return errorResult(id, {
      code: APP_ERRORS.RATE_LIMITED,
      message: "Sponsorship denied: rate-limit store unavailable",
    });
  }

  return null;
}

/**
 * Process one JSON-RPC request and return the HTTP status + JSON body to send.
 *
 * Policy denials and rate-limit rejections are returned as JSON-RPC error
 * objects with HTTP status 200 (the conventional JSON-RPC transport behaviour:
 * the HTTP layer succeeded, the RPC call did not).
 */
type HandlerResult = { status: number; body: object };

// Each step below either short-circuits with an error `HandlerResult` or yields
// the values the next step needs — kept as small discriminated unions so the
// orchestrator stays a flat, readable pipeline.
type ParsedRequest =
  | { ok: true; id: unknown; method: string; params: unknown }
  | { ok: false; error: HandlerResult };

type PolicyOutcome = { ok: true; params: unknown } | { ok: false; error: HandlerResult };

export async function handlePaymasterRequest(
  rawBody: string | object,
  config: ProxyConfig,
): Promise<HandlerResult> {
  const parsed = parseJsonRpcRequest(rawBody); // 1
  if (!parsed.ok) return parsed.error;

  const methodDenied = checkMethodAllowed(parsed.id, parsed.method); // 2
  if (methodDenied) return methodDenied;

  const policy = await enforcePolicy(parsed.id, parsed.method, parsed.params, config); // 3
  if (!policy.ok) return policy.error;

  return forwardToUpstream(parsed.id, parsed.method, policy.params, config); // 4
}

/** Step 1: parse the JSON-RPC 2.0 envelope and validate its shape. */
function parseJsonRpcRequest(rawBody: string | object): ParsedRequest {
  let req: JsonRpcRequest;
  try {
    req = typeof rawBody === "string" ? JSON.parse(rawBody) : (rawBody as JsonRpcRequest);
  } catch {
    return {
      ok: false,
      error: errorResult(null, { code: JSON_RPC_ERRORS.PARSE_ERROR, message: "Parse error" }),
    };
  }

  // Note: JSON-RPC 2.0 batch requests (array bodies) are INTENTIONALLY
  // unsupported and rejected as INVALID_REQUEST — SNIP-29 has no batching, and
  // single-request handling keeps the policy/rate-limit accounting simple.
  if (!req || typeof req !== "object" || Array.isArray(req) || typeof req.method !== "string") {
    return {
      ok: false,
      error: errorResult(req?.id, {
        code: JSON_RPC_ERRORS.INVALID_REQUEST,
        message: "Invalid Request",
      }),
    };
  }

  return { ok: true, id: req.id, method: req.method, params: req.params };
}

/** Step 2: reject methods outside the SNIP-29 allowlist. */
function checkMethodAllowed(id: unknown, method: string): HandlerResult | null {
  if (!ALLOWED_METHODS.has(method)) {
    return errorResult(id, {
      code: JSON_RPC_ERRORS.METHOD_NOT_FOUND,
      message: `Method not found: ${method}`,
    });
  }
  return null;
}

/**
 * Step 3: for a sponsoring method, enforce sponsorship policy + rate limit +
 * global cap on BOTH build and execute (execute is the call that actually spends
 * the gas budget), then force sponsored fee mode and strip/clamp client tips.
 * Non-sponsoring methods pass through with their params untouched.
 */
async function enforcePolicy(
  id: unknown,
  method: string,
  params: unknown,
  config: ProxyConfig,
): Promise<PolicyOutcome> {
  if (!SPONSORING_METHODS.has(method)) return { ok: true, params };

  const store = config.store ?? defaultStore;

  // 3a. Policy / allowlist check. extractTargets is method-aware: for execute
  //     it reads calls ONLY from the signed typed_data (never a client-supplied
  //     invoke.calls), preventing a confused-deputy bypass; for build it reads
  //     invoke.calls.
  const callSource = method === "paymaster_executeTransaction" ? "execute" : "build";
  let decision: PolicyDecision;
  try {
    const targets = extractTargets(params, callSource);
    if (!targets) {
      return {
        ok: false,
        error: errorResult(id, {
          code: JSON_RPC_ERRORS.INVALID_PARAMS,
          message: "Invalid params: missing transaction or transaction.type",
        }),
      };
    }
    decision = checkTransaction(targets, config.policy);
  } catch (e) {
    // Malformed or ambiguous input -> INVALID_PARAMS, never a 500.
    if (
      e instanceof InvalidFeltError ||
      e instanceof ConflictingAccountAddressError ||
      e instanceof InvalidOutsideExecutionError
    ) {
      return {
        ok: false,
        error: errorResult(id, {
          code: JSON_RPC_ERRORS.INVALID_PARAMS,
          message: `Invalid params: ${e.message}`,
        }),
      };
    }
    return {
      ok: false,
      error: errorResult(id, { code: JSON_RPC_ERRORS.INVALID_PARAMS, message: "Invalid params" }),
    };
  }

  if (!decision.ok) {
    return {
      ok: false,
      error: errorResult(id, {
        code: APP_ERRORS.POLICY_DENIED,
        message: `Sponsorship denied: ${decision.reason ?? "not allowed by policy"}`,
      }),
    };
  }

  // 3b. Rate limit + global budget (fail closed).
  const limited = await enforceLimits(id, decision, config.policy, store);
  if (limited) return { ok: false, error: limited };

  // 3c. Force sponsored fee mode and strip/clamp client tips before forwarding.
  return { ok: true, params: sanitizeParams(params, config.policy) };
}

/**
 * Step 4: forward to the upstream paymaster with the secret key injected, and
 * return its JSON verbatim. A JSON-RPC-level error from a 2xx response passes
 * through by design; transport failures are normalized to INTERNAL_ERROR so
 * upstream internals (which could include the key) never leak to the caller.
 */
async function forwardToUpstream(
  id: unknown,
  method: string,
  params: unknown,
  config: ProxyConfig,
): Promise<HandlerResult> {
  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(config.upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        [PAYMASTER_KEY_HEADER]: config.apiKey,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? [] }),
    });
  } catch {
    return errorResult(id, {
      code: JSON_RPC_ERRORS.INTERNAL_ERROR,
      message: "Upstream paymaster request failed",
    });
  }

  if (!upstreamResponse.ok) {
    return errorResult(id, {
      code: JSON_RPC_ERRORS.INTERNAL_ERROR,
      message: "Upstream paymaster request failed",
    });
  }

  let upstreamJson: unknown;
  try {
    upstreamJson = await upstreamResponse.json();
  } catch {
    return errorResult(id, {
      code: JSON_RPC_ERRORS.INTERNAL_ERROR,
      message: "Invalid response from upstream paymaster",
    });
  }

  return { status: 200, body: upstreamJson as object };
}

// Shared default store so rate-limit state survives across calls in a single instance.
const defaultStore: RateLimitStore = new InMemoryRateLimitStore();
