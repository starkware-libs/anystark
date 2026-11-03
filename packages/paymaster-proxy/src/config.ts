// Helper to build a ProxyConfig from environment variables. Shared by the
// Vercel and Cloudflare adapters.

import type { ProxyConfig, RateLimitStore } from "./handler.js";
import {
  assertUniqueAllowedCallTargets,
  hasLimit,
  normalizeFelt,
  type AllowedCall,
  type SponsorshipPolicy,
} from "./policy.js";
import { RedisRateLimitStore, type UpstashEnv } from "./redis-store.js";

export interface ProxyEnv extends UpstashEnv {
  PAYMASTER_API_KEY?: string;
  PAYMASTER_UPSTREAM_URL?: string;
  PAYMASTER_POLICY?: string;
}

const DEFAULT_UPSTREAM = "https://sepolia.paymaster.avnu.fi";

/**
 * Build a full `ProxyConfig` (including the `store`) from env vars.
 *
 * Throws if the API key or policy JSON are missing/invalid so the deployment
 * fails loudly rather than silently sponsoring nothing or leaking misconfig.
 *
 * Store selection + FAIL-CLOSED guard:
 *   - If `UPSTASH_REDIS_REST_URL`/`_TOKEN` are set, uses a durable
 *     `RedisRateLimitStore`.
 *   - Otherwise, if a rate limit / global cap is configured, THROWS unless
 *     `policy.allowInMemoryStore === true` — so a production deployment without
 *     a durable store refuses to start instead of silently un-limiting.
 */
export function configFromEnv(env: ProxyEnv): ProxyConfig {
  const apiKey = env.PAYMASTER_API_KEY;
  if (!apiKey) {
    throw new Error("Missing PAYMASTER_API_KEY environment variable");
  }

  const upstreamUrl = env.PAYMASTER_UPSTREAM_URL || DEFAULT_UPSTREAM;

  if (!env.PAYMASTER_POLICY) {
    throw new Error("Missing PAYMASTER_POLICY environment variable");
  }
  let policy: SponsorshipPolicy;
  try {
    policy = JSON.parse(env.PAYMASTER_POLICY) as SponsorshipPolicy;
  } catch {
    throw new Error("PAYMASTER_POLICY is not valid JSON");
  }
  if (!Array.isArray(policy.allowedCalls) || !Array.isArray(policy.sponsoredClassHashes)) {
    throw new Error("PAYMASTER_POLICY must have allowedCalls[] and sponsoredClassHashes[]");
  }

  // Validate the felt contents at startup so a malformed policy fails the DEPLOY
  // loudly, rather than passing config validation and then making checkTransaction
  // throw InvalidFeltError -> INVALID_PARAMS on every legitimate request at runtime.
  validatePolicyFelts(policy);

  // FAIL CLOSED: reject a policy that lists the same target in two allowedCalls
  // entries. Duplicates would otherwise be silently last-write-wins when the
  // allowlist is compiled, either narrowing (dropping selectors the dApp needs)
  // or broadening (granting any-selector and exposing the budget) the allowlist.
  // Runs after validatePolicyFelts so every `to` is a known-valid felt here.
  assertUniqueAllowedCallTargets(policy);

  const store: RateLimitStore | undefined = RedisRateLimitStore.fromEnv(env);
  if (!store && hasLimit(policy) && !policy.allowInMemoryStore) {
    // FAIL CLOSED: a configured limit with no durable store would silently not
    // enforce on serverless. Refuse to start.
    throw new Error(
      "rateLimit/globalCap is configured but no durable store is available: " +
        "set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN, or set " +
        "policy.allowInMemoryStore=true for local/single-instance use only",
    );
  }

  return { upstreamUrl, apiKey, policy, store };
}

/**
 * Eagerly validate every felt in the policy (allowlist targets + selectors and
 * sponsored class hashes). Throws a clear config error naming the offending
 * value so a bad policy is rejected at deploy time. normalizeFelt itself throws
 * InvalidFeltError on malformed/out-of-range felts; we wrap that into a config
 * error so the failure reads as "your policy is wrong", not a runtime fault.
 */
function validatePolicyFelts(policy: SponsorshipPolicy): void {
  const check = (value: string, where: string) => {
    try {
      normalizeFelt(value);
    } catch {
      throw new Error(`PAYMASTER_POLICY contains a malformed felt in ${where}: ${value}`);
    }
  };
  policy.allowedCalls.forEach((c: AllowedCall, i) => {
    check(c.to, `allowedCalls[${i}].to`);
    (c.selectors ?? []).forEach((s, j) => check(s, `allowedCalls[${i}].selectors[${j}]`));
  });
  policy.sponsoredClassHashes.forEach((h, i) => check(h, `sponsoredClassHashes[${i}]`));
}
