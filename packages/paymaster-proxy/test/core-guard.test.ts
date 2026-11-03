import { describe, expect, it } from "vitest";
import { assertCoreDeployClassHashSponsored } from "../src/core-guard.js";
import { normalizeFelt, type SponsorshipPolicy } from "../src/policy.js";

// The guard imports @starkware-libs/anystark-core (vitest resolves it to core's source).
// Reference the SAME pinned deploy class hash the guard checks against, imported TS-to-TS
// from core/src (config.ts is pure constants, key_to_address.ts imports only starknet), so
// this test needs no built dist.
import { CHAIN_IDS } from "../../core/src/config";
import { resolveDeployClassHash } from "../../core/src/key_to_address";

const SEPOLIA_DEPLOY_CLASS_HASH = resolveDeployClassHash({ chainId: CHAIN_IDS.sepolia });

function policyWithSponsored(sponsoredClassHashes: string[]): SponsorshipPolicy {
  return { allowedCalls: [], sponsoredClassHashes };
}

describe("assertCoreDeployClassHashSponsored", () => {
  it("passes when the policy sponsors core's pinned deploy class hash", () => {
    expect(() =>
      assertCoreDeployClassHashSponsored(policyWithSponsored([SEPOLIA_DEPLOY_CLASS_HASH])),
    ).not.toThrow();
  });

  it("passes when the pinned hash is sponsored alongside additional class hashes", () => {
    expect(() =>
      assertCoreDeployClassHashSponsored(
        policyWithSponsored(["0xdead", SEPOLIA_DEPLOY_CLASS_HASH, "0xbeef"]),
      ),
    ).not.toThrow();
  });

  it("passes across felt spellings of the pinned hash (extra leading zero, uppercase hex)", () => {
    // Re-spell the canonical pinned hash with an added leading zero and uppercase hex; the
    // guard normalizes both sides, so this still counts as the pinned hash being present.
    const canonical = normalizeFelt(SEPOLIA_DEPLOY_CLASS_HASH);
    const respelled = "0x0" + canonical.slice(2).toUpperCase();
    expect(() =>
      assertCoreDeployClassHashSponsored(policyWithSponsored([respelled])),
    ).not.toThrow();
  });

  it("fails closed and names both the core-pinned hash and the policy hashes when absent", () => {
    const otherHash = "0x1234";
    let thrown: Error | undefined;
    try {
      assertCoreDeployClassHashSponsored(policyWithSponsored([otherHash]));
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown).toBeDefined();
    // The message names core's pinned hash and the policy's sponsored hash so an operator
    // can see exactly what to reconcile.
    expect(thrown?.message).toContain(normalizeFelt(SEPOLIA_DEPLOY_CLASS_HASH));
    expect(thrown?.message).toContain(normalizeFelt(otherHash));
  });

  it("fails closed when sponsoredClassHashes is empty", () => {
    expect(() => assertCoreDeployClassHashSponsored(policyWithSponsored([]))).toThrow(
      /does not sponsor the AnyStark account deploy class hash/,
    );
  });
});
