// Startup version-skew guard between the proxy's sponsorship policy and the
// installed @starkware-libs/anystark-core.
//
// The frontend SDK derives and deploys the AnyStark account against the `deploy`
// class hash pinned by the @starkware-libs/anystark-core it is built with. The proxy
// only sponsors class hashes listed in PAYMASTER_POLICY.sponsoredClassHashes. If a
// proxy resolves a DIFFERENT core version (whose pinned hash the policy does not
// sponsor), the proxy denies every first-touch account deployment the SDK produces,
// silently, on the fund-critical path. This guard asserts at startup that the
// policy sponsors the deploy class hash pinned by the installed core and fails
// closed with an actionable message when it does not.
//
// IMPORTANT (generator round-trip constraint): this module STATICALLY imports
// @starkware-libs/anystark-core, so it must NEVER be imported (even transitively) by
// config.ts, policy.ts, or redis-store.ts. scripts/generate_policy.mjs loads the
// compiled dist/src/config.js under plain node, where the workspace core resolves to
// TypeScript source that node cannot execute; pulling core into that graph would
// break the generator. That is why the guard is wired into each adapter's memoized
// config resolution (its bootstrap) rather than inside configFromEnv, and why
// configFromEnv itself stays synchronous and core-free.
//
// Guard semantics: the check is "at least one core-pinned hash is present in the
// policy", not exact equality. A policy that also sponsors additional class hashes
// passes. Core pins per chain (sepolia today); the guard sponsors the presence of
// ANY pinned hash. Chain identity is not visible to the proxy, so once core pins a
// second chain a policy sponsoring only one chain's hash still passes; that is the
// agreed presence check.

import { CHAIN_IDS, resolveDeployClassHash } from "@starkware-libs/anystark-core";
import { normalizeFelt, type SponsorshipPolicy } from "./policy.js";

/** A deploy class hash pinned by the installed core, with the chain it belongs to. */
interface PinnedCoreHash {
  /** Chain name from CHAIN_IDS (e.g. "sepolia"). */
  chain: string;
  /** Canonical felt form of the pinned deploy class hash. */
  hash: string;
}

/**
 * Every deploy class hash the installed @starkware-libs/anystark-core pins, one per
 * chain in CHAIN_IDS that resolves. Chains with no pinned hash (resolveDeployClassHash
 * throws) are skipped, so this returns only the hashes the SDK could actually deploy.
 */
function pinnedCoreHashes(): PinnedCoreHash[] {
  const pinned: PinnedCoreHash[] = [];
  for (const [chain, chainId] of Object.entries(CHAIN_IDS)) {
    try {
      pinned.push({ chain, hash: normalizeFelt(resolveDeployClassHash({ chainId })) });
    } catch {
      // No pinned hash for this chain in the installed core; nothing to require.
    }
  }
  return pinned;
}

/**
 * Assert the policy sponsors the AnyStark account `deploy` class hash pinned by the
 * installed @starkware-libs/anystark-core. Passes when the policy's
 * sponsoredClassHashes contains AT LEAST ONE core-pinned hash (extra sponsored
 * hashes are fine); throws (fail closed) naming both the core-pinned hash(es) and
 * the policy's sponsoredClassHashes otherwise, so a version skew is caught at
 * startup rather than silently denying every account deployment at runtime.
 */
export function assertCoreDeployClassHashSponsored(policy: SponsorshipPolicy): void {
  const pinned = pinnedCoreHashes();
  const sponsored = new Set(policy.sponsoredClassHashes.map(normalizeFelt));

  if (pinned.some(({ hash }) => sponsored.has(hash))) {
    return;
  }

  const pinnedList = pinned.map(({ chain, hash }) => `${hash} (${chain})`).join(", ");
  const sponsoredList = [...sponsored].join(", ") || "(none)";
  throw new Error(
    "PAYMASTER_POLICY does not sponsor the AnyStark account deploy class hash pinned by " +
      "the installed @starkware-libs/anystark-core. " +
      `Core pins ${pinnedList || "(no chains pinned)"}, but the policy sponsoredClassHashes ` +
      `are ${sponsoredList}. The proxy would deny every account deployment the frontend SDK ` +
      "produces. Regenerate PAYMASTER_POLICY with the policy generator against the installed " +
      "@starkware-libs/anystark-core (npx --package @starkware-libs/anystark-paymaster-proxy " +
      "anystark-paymaster-policy ...), or add the pinned hash to sponsoredClassHashes.",
  );
}
