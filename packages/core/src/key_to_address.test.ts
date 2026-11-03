import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ED25519_TORSION_SUBGROUP, ed25519 } from "@noble/curves/ed25519";
import { describe, expect, it } from "vitest";
import { num } from "starknet";
import { CHAIN_IDS } from "./config";
import {
  CLASS_HASH_UNRESOLVED_ERROR,
  SOL_ACCOUNT_CLASS_HASHES,
  classHashesForChain,
  deriveSolAccountAddress,
  pubkeyToU256Limbs,
  resolveDeployClassHash,
} from "./key_to_address";

describe("resolveDeployClassHash", () => {
  it("resolves the class hash from SOL_ACCOUNT_CLASS_HASHES by chainId", () => {
    expect(resolveDeployClassHash({ chainId: CHAIN_IDS.sepolia })).toBe(
      SOL_ACCOUNT_CLASS_HASHES[CHAIN_IDS.sepolia],
    );
  });

  it("resolves the mainnet class hash by chainId", () => {
    expect(resolveDeployClassHash({ chainId: CHAIN_IDS.mainnet })).toBe(
      SOL_ACCOUNT_CLASS_HASHES[CHAIN_IDS.mainnet],
    );
  });

  it("throws when no known chainId is given", () => {
    expect(() => resolveDeployClassHash({})).toThrow(CLASS_HASH_UNRESOLVED_ERROR);
    expect(() => resolveDeployClassHash({ chainId: "0xdead" })).toThrow(
      CLASS_HASH_UNRESOLVED_ERROR,
    );
  });
});

describe("sepolia class hash (frozen literal lock)", () => {
  // This literal is frozen forever for sepolia: counterfactual addresses derive
  // from it, so it must NEVER change once accounts exist. If this test fails,
  // someone edited the pinned class hash, which is exactly the mistake it exists to
  // catch (a re-declare to a new class is a deliberate one-time reset, done only
  // while there are no users, not a routine bump).
  it("sepolia class hash is frozen (must never change)", () => {
    expect(SOL_ACCOUNT_CLASS_HASHES[CHAIN_IDS.sepolia]).toBe(
      "0x07ec6a68af00a71582569f94ee3ec85eb530365a06b6b7cefbef8f2f8f6c2288",
    );
  });
});

describe("mainnet class hash (frozen literal lock)", () => {
  // A class hash is a hash of the contract class itself, so it is network-independent:
  // mainnet pins the SAME value as sepolia, and the two MUST stay equal (a given key
  // derives the same address on both networks). Frozen for the same reason as sepolia -
  // counterfactual addresses derive from it - so it must never change once accounts
  // exist. Declaration is still per-network; see the mainnet public e2e.
  it("mainnet class hash is frozen and equals the sepolia hash", () => {
    expect(SOL_ACCOUNT_CLASS_HASHES[CHAIN_IDS.mainnet]).toBe(
      "0x07ec6a68af00a71582569f94ee3ec85eb530365a06b6b7cefbef8f2f8f6c2288",
    );
    expect(SOL_ACCOUNT_CLASS_HASHES[CHAIN_IDS.mainnet]).toBe(
      SOL_ACCOUNT_CLASS_HASHES[CHAIN_IDS.sepolia],
    );
  });
});

describe("classHashesForChain (selector)", () => {
  // Synthetic map so the selector is exercised against a value distinct from the
  // real sepolia entry.
  const SYNTHETIC = { "0xfeed": "0x0aaa" } as const;

  it("returns the class hash for a present chain", () => {
    expect(classHashesForChain("0xfeed", SYNTHETIC)).toBe("0x0aaa");
  });

  it("throws for an absent chain and for an undefined chainId", () => {
    expect(() => classHashesForChain("0xnope", SYNTHETIC)).toThrow(CLASS_HASH_UNRESOLVED_ERROR);
    expect(() => classHashesForChain(undefined, SYNTHETIC)).toThrow(CLASS_HASH_UNRESOLVED_ERROR);
  });
});

// Locked TS/Cairo derivation vector (fund-safety gate)
// Fixed pubkey (bytes 0..31) against the deploy class hash. EXPECTED MUST NOT
// drift; a change means TS derives a different address than where the contract
// deploys. Recompute deliberately (and re-verify against Cairo) only when the
// class hash intentionally changes.
//
// The SALT and ADDRESS are independently bound to the Cairo runtime (not just
// asserted TS-against-TS):
//   - SALT: the derived_salt_matches_ts_locked_vector test in
//     packages/contracts/src/test_sol_account.cairo asserts Cairo's
//     poseidon_hash_span over these limbs equals EXPECTED.salt.
//   - ADDRESS: cross-checked against ./__fixtures__/cairo_derivation_vector.json
//     below - the (class_hash, address) pair the Cairo runtime actually produced by
//     deploying SolAccount with deploy_from_zero at salt = poseidon(limbs).
// EXPECTED is bound to the pinned (frozen) class hash. Regenerate it (run the fix
// script packages/core/scripts/gen_derivation_vector.mjs and paste its output
// block) only when the pinned class hash intentionally changes (a one-time reset
// while there are no users) or if the test pubkey changes.
const PUBKEY = Uint8Array.from(Array.from({ length: 32 }, (_, i) => i));
// User-facing counterfactual addresses derive from the pinned class hash, so the
// EXPECTED locked vector and the address-pin below stay bound to it.
const DEPLOY_CLASS_HASH = SOL_ACCOUNT_CLASS_HASHES[CHAIN_IDS.sepolia];

const EXPECTED = {
  low: 0xf0e0d0c0b0a09080706050403020100n,
  high: 0x1f1e1d1c1b1a19181716151413121110n,
  salt: "0x7c4c5d1a2d076d49a47a4b8db8a10dbabdb0920328deb23b0a9ad9273d3d348",
  // This address is deliberately re-pinned in two other places:
  // packages/react/src/sepolia.live.e2e.test.ts and
  // packages/react/src/sepolia.public.e2e.test.ts (both as LOCKED_VECTOR_ADDRESS), which
  // re-assert it against a real Sepolia RPC. Keep all three in lockstep if this ever changes.
  address: "0x3011dc8056908306c2c0fbf47a0d470318e1871323311951eff05d333bfc7b7",
};

// The (class_hash, address) pair the Cairo runtime minted (see the fixture's
// _readme). deployer=0 + salt = poseidon(limbs) makes the deployed address a pure
// function of the class hash, so this binds starknet.js's address formula to the
// real Cairo deployment. The cross-check below also asserts this class_hash equals
// the pinned class hash (the Cairo oracle declares the current source, which is the
// single pinned class), so a stale fixture from an old contract build fails loudly.
const CAIRO_FIXTURE: { class_hash: string; address: string } = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./__fixtures__/cairo_derivation_vector.json", import.meta.url)),
    "utf8",
  ),
);

describe("sol_account derivation (locked vector)", () => {
  it("splits the pubkey into the expected little-endian u256 limbs", () => {
    const { low, high } = pubkeyToU256Limbs(PUBKEY);
    expect(low).toBe(EXPECTED.low);
    expect(high).toBe(EXPECTED.high);
  });

  it("derives the locked salt + counterfactual address", () => {
    const derivation = deriveSolAccountAddress(PUBKEY, DEPLOY_CLASS_HASH);
    expect(derivation.salt).toBe(EXPECTED.salt);
    expect(derivation.address).toBe(EXPECTED.address);
    expect(derivation.calldata).toEqual([num.toHex(EXPECTED.low), num.toHex(EXPECTED.high)]);
  });

  // Cross Cairo/TS binding: the address deriveSolAccountAddress computes for the
  // fixture's class_hash MUST equal the address the Cairo runtime actually deployed
  // to (deploy_from_zero, salt = poseidon(limbs)). This binds the derivation FORMULA
  // (poseidon salt, calldata order, deployer=0) to the Cairo runtime using the
  // class the current source builds (the single pinned class), proving starknet.js's
  // calculateContractAddressFromHash + deployer=0 agrees with the on-chain formula.
  // The deploy-address pin (the actual user-facing counterfactual address) lives in
  // the EXPECTED locked vector above, which stays bound to the pinned class hash.
  //
  // Provenance of the checks: the load-bearing new assertion is the class_hash
  // equality (the staleness guard that fires if the contract is re-declared without
  // regenerating the fixture). The address equality re-derives in TS against a
  // Cairo-minted constant, so it is provenance-based; the salt equality
  // (derived_salt_matches_ts_locked_vector) is a live cross-runtime Cairo/TS check; and
  // the sepolia e2e re-pins the address against a live RPC out of band.
  it("derives the address the Cairo runtime deployed to (cross-check)", () => {
    // Bind the fixture to the pinned class hash. The Cairo oracle declares the
    // current source, so the vector carries the single pinned class. If the contract
    // is re-declared but the fixture isn't regenerated, the fixture's (class_hash,
    // address) pair stays self-consistent and would silently pass; this assertion
    // makes that staleness fail loudly instead. Compared via num.toHex so leading-zero
    // padding differences don't matter.
    expect(num.toHex(CAIRO_FIXTURE.class_hash)).toBe(num.toHex(DEPLOY_CLASS_HASH));
    const derivation = deriveSolAccountAddress(PUBKEY, CAIRO_FIXTURE.class_hash);
    expect(num.toHex(derivation.address)).toBe(num.toHex(CAIRO_FIXTURE.address));
  });

  it("rejects a pubkey that is not 32 bytes", () => {
    expect(() => pubkeyToU256Limbs(new Uint8Array(31))).toThrow();
  });

  // The constructor (packages/contracts/src/lib.cairo) rejects pk==0 and
  // non-canonical keys (y >= field prime); the TS layer must reject the same so
  // it never hands out a counterfactual address whose account can't deploy.
  it("rejects the all-zero key (pk == 0)", () => {
    const zero = new Uint8Array(32);
    expect(() => pubkeyToU256Limbs(zero)).toThrow();
    expect(() => deriveSolAccountAddress(zero, DEPLOY_CLASS_HASH)).toThrow();
  });

  it("rejects a non-canonical key with y >= field prime (all-0xFF bytes)", () => {
    const nonCanonical = new Uint8Array(32).fill(0xff);
    expect(() => pubkeyToU256Limbs(nonCanonical)).toThrow();
    expect(() => deriveSolAccountAddress(nonCanonical, DEPLOY_CLASS_HASH)).toThrow();
  });
});

// The SDK rejects keys the deployed constructor cannot (off-curve, small-order)
// before deriving an address, because such keys can never produce a signature
// garaga accepts: funds sent to their derived address would be unrecoverable.
describe("sol_account key curve validation", () => {
  // Real, on-curve Phantom-style keys (Ed25519 public keys) from fixed seeds
  // derive without throwing, and their derived address is a well-formed felt.
  it("accepts valid on-curve Ed25519 public keys", () => {
    for (const seedByte of [1, 42, 200]) {
      const pubkey = ed25519.getPublicKey(new Uint8Array(32).fill(seedByte));
      expect(() => pubkeyToU256Limbs(pubkey)).not.toThrow();
      const derivation = deriveSolAccountAddress(pubkey, DEPLOY_CLASS_HASH);
      expect(num.toBigInt(derivation.address)).toBeGreaterThan(0n);
    }
  });

  // Deterministic off-curve key: the smallest y >= 2 whose little-endian
  // encoding noble's fromHex rejects as not on the curve (y = 2 here). It clears
  // the non-zero and canonical (y < p) checks, so only the curve check can reject
  // it.
  it("rejects an off-curve key (smallest y >= 2 that is not on the curve)", () => {
    let offCurve: Uint8Array | undefined;
    for (let y = 2n; y < 32n; y++) {
      const encoding = new Uint8Array(32);
      let v = y;
      for (let i = 0; i < 32; i++) {
        encoding[i] = Number(v & 0xffn);
        v >>= 8n;
      }
      try {
        ed25519.ExtendedPoint.fromHex(encoding);
      } catch {
        offCurve = encoding;
        break;
      }
    }
    if (!offCurve) throw new Error("expected to find an off-curve y in range");
    expect(() => pubkeyToU256Limbs(offCurve)).toThrow(/curve point/);
    expect(() => deriveSolAccountAddress(offCurve, DEPLOY_CLASS_HASH)).toThrow(/curve point/);
  });

  // Every canonical small-order encoding (the eight points whose order divides
  // the cofactor 8). Source: noble's ED25519_TORSION_SUBGROUP, the wire-format
  // (little-endian compressed) encodings of the torsion subgroup. One of the
  // eight is the all-zero encoding, which is caught by the pre-existing
  // non-zero guard rather than the small-order check, so it asserts a
  // different message than the rest; every entry is still covered.
  it("rejects every canonical small-order encoding", () => {
    for (const hex of ED25519_TORSION_SUBGROUP) {
      const encoding = Uint8Array.from(Buffer.from(hex, "hex"));
      const isAllZero = encoding.every((byte) => byte === 0);
      const expectedError = isAllZero ? /non-zero/ : /small-order/;
      expect(() => pubkeyToU256Limbs(encoding)).toThrow(expectedError);
      expect(() => deriveSolAccountAddress(encoding, DEPLOY_CLASS_HASH)).toThrow(expectedError);
    }
  });
});
