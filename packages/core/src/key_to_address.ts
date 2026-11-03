// ─── Phantom pubkey → sol_account address (fund-safety critical) ───
// A Phantom user's Starknet address is counterfactually derived from the
// sol_account CLASS HASH. A wrong hash derives a different address — bridged
// funds there are recoverable only by deploying an account against that same
// wrong hash, a manual and error-prone process. So the hash must be pinned and
// identical to the class actually declared on each network.
//
// The hash is fixed by the compiled Sierra (see packages/contracts). Update this
// map whenever the contract changes and is re-declared.

import { ed25519 } from "@noble/curves/ed25519";
import { hash, num } from "starknet";
import { CHAIN_IDS, type ChainId, type PhantomConnectorConfig } from "./config";

/**
 * Pinned `sol_account` class hash per Starknet chain id: a SINGLE frozen hash
 * per chain.
 *
 * A Phantom user's Starknet address is counterfactually derived from this class
 * hash, so once any address has been derived for a chain the hash is frozen
 * forever: changing it would derive a different address and strand funds already
 * bridged to the old one. Never overwrite an existing chain's hash.
 *
 * There is deliberately no `latest`/registry split and no SDK-managed upgrade
 * target: the SDK pins exactly the one class it deploys and derives from. A user
 * who wants to move to a newer class calls `account.upgrade(classHash)` with an
 * explicit, declared target (see account.ts). The hash must be DECLARED on the
 * target network before the SDK works there.
 *
 * Both entries are the v1 identity-guarded sol_account. A class hash is a hash of
 * the contract class itself, so it is network-independent: mainnet and sepolia pin
 * the SAME value, and a given key derives the SAME address on both networks. The
 * value is fixed by the compiled Sierra (see packages/contracts); the
 * compiled-class-hash lock in class_hash.test.ts binds it to the committed fixture.
 * Declaring the class is per-network, so each entry still requires its own
 * on-chain declaration on that network before deploys land there.
 *
 * TODO: consider supporting custom chains (e.g. devnets) via an
 * explicit class-hash override in the config.
 *
 * Accepts anything carrying a `chainId` (the full PhantomConnectorConfig or a
 * bare `{ chainId }`), so callers that only know the chain - e.g. an account
 * resolving its own network's class hash - need not synthesize a config.
 */
export const SOL_ACCOUNT_CLASS_HASHES: Readonly<Record<string, string>> = {
  [CHAIN_IDS.sepolia]: "0x07ec6a68af00a71582569f94ee3ec85eb530365a06b6b7cefbef8f2f8f6c2288",
  [CHAIN_IDS.mainnet]: "0x07ec6a68af00a71582569f94ee3ec85eb530365a06b6b7cefbef8f2f8f6c2288",
};

/**
 * Thrown by the class-hash resolvers when `chainId` is absent or not present in
 * SOL_ACCOUNT_CLASS_HASHES.
 */
export const CLASS_HASH_UNRESOLVED_ERROR =
  "sol_account class hash unresolved: pass a `chainId` present in SOL_ACCOUNT_CLASS_HASHES.";

/**
 * Look up the pinned sol_account class hash for a chain, throwing if the chain is
 * absent. Exported for tests (via a relative import); intentionally NOT
 * re-exported from index.ts. `classHashes` is injectable so tests can pass a
 * synthetic map.
 */
export function classHashesForChain(
  chainId: string | undefined,
  classHashes: Readonly<Record<string, string>> = SOL_ACCOUNT_CLASS_HASHES,
): string {
  const chainClassHash = chainId ? classHashes[chainId] : undefined;
  if (!chainClassHash) throw new Error(CLASS_HASH_UNRESOLVED_ERROR);
  return chainClassHash;
}

/**
 * Resolve the pinned (frozen) sol_account class hash for a config by looking up
 * `chainId` in SOL_ACCOUNT_CLASS_HASHES. This is the hash used to DECLARE +
 * DEPLOY new accounts and, critically, to derive the counterfactual address.
 * Throws if the chain is unknown, since deriving against the wrong/empty hash
 * would send funds to an unintended address.
 */
export function resolveDeployClassHash(config: Pick<PhantomConnectorConfig, "chainId">): string {
  return classHashesForChain(config.chainId);
}

export type { ChainId };

/**
 * The result of deriving a Phantom pubkey's counterfactual `sol_account` (produced
 * by `deriveSolAccountAddress`): the deploy inputs (`salt`, `calldata`) and the
 * resulting `address`. `pk`/`low`/`high` are the derivation intermediates, kept on
 * the result for inspection and debugging.
 */
export interface SolAccountDerivation {
  /** The 32-byte pubkey read as a little-endian u256 (garaga's `Py_twisted`, its
   *  twisted-Edwards y coordinate). Derivation intermediate. */
  pk: bigint;
  /** The 128-bit low/high limbs of `pk`: the poseidon-salt inputs and the
   *  constructor calldata felts. Derivation intermediates. */
  low: bigint;
  high: bigint;
  /** The counterfactual-address salt, `poseidon([low, high])`. */
  salt: string;
  /** Constructor calldata for the counterfactual deploy: `[low, high]` as hex felts. */
  calldata: string[];
  /** The counterfactual Starknet address (can receive CCTP mints before deploy). */
  address: string;
}

// Canonical-key bounds, byte-identical to the constructor in
// packages/contracts/src/lib.cairo (ED25519_FIELD_PRIME / ED25519_Y_MASK). An
// Ed25519 pubkey's low 255 bits are the point's y coordinate and bit 255 is x's
// sign; the encoding is canonical only when y < p, where p = 2^255 - 19.
// The SDK also checks more than the deployed constructor does; see the curve
// and small-order checks in pubkeyToU256Limbs below for why.
const ED25519_FIELD_PRIME = (1n << 255n) - 19n;
const ED25519_Y_MASK = (1n << 255n) - 1n;

/** 32-byte Ed25519 pubkey → little-endian u256 → its [low, high] limbs. */
export function pubkeyToU256Limbs(pubkey32: Uint8Array): {
  pk: bigint;
  low: bigint;
  high: bigint;
} {
  if (pubkey32.length !== 32) {
    throw new Error(`pubkey must be 32 bytes, got ${pubkey32.length}`);
  }
  let pk = 0n;
  for (let i = 0; i < 32; i++) {
    pk |= BigInt(pubkey32[i]) << BigInt(8 * i); // little-endian
  }
  // Mirror the constructor's validation so the SDK can never derive an address
  // whose account would revert at deploy, bricking any funds already minted to it.
  if (pk === 0n) {
    throw new Error("pubkey must be non-zero");
  }
  if ((pk & ED25519_Y_MASK) >= ED25519_FIELD_PRIME) {
    throw new Error("pubkey is not a canonical Ed25519 key (y >= field prime)");
  }
  // Beyond the constructor's checks: reject keys that never decompress onto the
  // curve and small-order keys. Either kind can never produce a signature garaga
  // accepts, so an address derived from one would receive funds it can never
  // spend. `pubkey32` is the point's standard little-endian compressed encoding
  // (the same bytes read into `pk`, sign bit in bit 255 included), so hand it to
  // noble unchanged: fromHex rejects off-curve (and non-canonical) encodings, and
  // isSmallOrder rejects the eight torsion points whose order divides the
  // cofactor 8.
  let point: ReturnType<typeof ed25519.ExtendedPoint.fromHex>;
  try {
    point = ed25519.ExtendedPoint.fromHex(pubkey32);
  } catch {
    throw new Error("pubkey is not a valid Ed25519 curve point");
  }
  if (point.isSmallOrder()) {
    throw new Error("pubkey is a small-order Ed25519 point");
  }
  const low = pk & ((1n << 128n) - 1n);
  const high = pk >> 128n;
  return { pk, low, high };
}

/**
 * Counterfactual `sol_account` address for a Phantom pubkey. `classHash` is the
 * pinned `deploy` hash of the deployed contract (see SOL_ACCOUNT_CLASS_HASHES
 * above); a wrong hash derives a different address, recoverable only by
 * deploying an account against that same wrong hash.
 *
 * The derivation MUST stay byte-identical to packages/contracts (sol_account.cairo);
 * the locked vector in key_to_address.test.ts guards it. The 32-byte Ed25519 pubkey
 * is read as a little-endian u256, then:
 *     calldata = [pk.low, pk.high]   // constructor(public_key: u256)
 *     salt     = poseidon([pk.low, pk.high])
 *     address  = calculateContractAddressFromHash(salt, classHash, calldata, 0)
 * The trailing `0` is the deployer address: the account is self-derived (no deployer
 * contract), and the deploy is bundled into the first sponsored execute() via SNIP-29
 * `deploy_and_invoke`.
 */
export function deriveSolAccountAddress(
  pubkey32: Uint8Array,
  classHash: string,
): SolAccountDerivation {
  const { pk, low, high } = pubkeyToU256Limbs(pubkey32);
  const salt = hash.computePoseidonHashOnElements([low, high]);
  const calldata = [num.toHex(low), num.toHex(high)];
  const address = hash.calculateContractAddressFromHash(salt, classHash, calldata, 0);
  return { pk, low, high, salt, calldata, address };
}
