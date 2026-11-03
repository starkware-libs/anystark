// Shared plumbing for the Sepolia e2e suites. This is deliberately NOT a *.test.ts
// file so vitest never collects it as a suite of its own; it only exports helpers
// that sepolia.live.e2e.test.ts (opt-in, real network + real funds) and
// sepolia.public.e2e.test.ts (default-on, public RPC, no secrets) both import.
//
// Nothing here reads process.env or opens a network connection at import time —
// every function takes its provider / keys as arguments, so importing this module
// is side-effect-free (installPhantom is the sole exception and only runs when
// called).

import {
  createPrivateKey,
  createPublicKey,
  sign as ed25519Sign,
  type KeyObject,
} from "node:crypto";
import { CallData, cairo, type Call } from "starknet";

// Sepolia STRK ERC-20 (fee token); balances/transfers are read via provider.callContract.
const STRK_ADDRESS = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
// SRC5 interface ids, copied from the exact felts in openzeppelin_interfaces-2.1.0
// (introspection.cairo / account/accounts.cairo / account/src9.cairo), the same
// constants packages/contracts asserts against in test_sol_account.cairo. NOT from memory.
export const ISRC6_ID = "0x2ceccef7f994940b3962a6c67e0ba4fcd37df7d131417c604f91e03caecc1cd";
export const ISRC9_V2_ID = "0x1d1144bb2138366ff28d8e9ab57456b1d332ac42196230c3a602003c89872";
// PKCS8 DER prefix that wraps a raw 32-byte Ed25519 seed into an importable private key.
const ED25519_PKCS8_PREFIX = "302e020100300506032b657004220420";

/** A provider surface small enough for both suites: only the raw read primitive
 *  the helpers below need. Kept structural so both RpcProvider instances satisfy it. */
export interface CallContractProvider {
  callContract(call: {
    contractAddress: string;
    entrypoint: string;
    calldata: string[];
  }): Promise<string[]>;
}

/**
 * Derive an Ed25519 keypair from a 32-byte seed given as 64 hex chars (an optional
 * `0x` prefix and surrounding whitespace are tolerated). The raw 32-byte public key
 * is the tail of the SPKI DER encoding — exactly the bytes deriveSolAccountAddress
 * expects. Throws on a malformed seed so a caller can never sign with a partial key.
 */
export function seedToKeypair(seed: string): {
  walletPrivateKey: KeyObject;
  pubkeyBytes: Uint8Array;
} {
  const seedHex = seed.trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(seedHex)) {
    throw new Error("seed must be exactly 64 hex characters (a 32-byte Ed25519 seed).");
  }
  const seedBytes = Buffer.from(seedHex, "hex");
  const walletPrivateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from(ED25519_PKCS8_PREFIX, "hex"), seedBytes]),
    format: "der",
    type: "pkcs8",
  });
  const spkiDer = createPublicKey(walletPrivateKey).export({ format: "der", type: "spki" });
  const pubkeyBytes = Uint8Array.from(spkiDer.subarray(spkiDer.length - 32));
  return { walletPrivateKey, pubkeyBytes };
}

/** Install a mock Phantom provider on globalThis.window so PhantomConnector wraps it
 *  and runs byte-for-byte as a dapp runs it — only the wallet is mocked (fetch is NOT).
 *  When `walletPrivateKey` is supplied, signMessage signs for real with it; when it is
 *  omitted (the public, no-signing tier) signMessage throws, so an accidental sign path
 *  fails loud instead of returning garbage. Call afterAll: `delete globalThis.window`. */
export function installPhantom(pubkeyBytes: Uint8Array, walletPrivateKey?: KeyObject): void {
  const publicKey = { toBytes: () => pubkeyBytes, toString: () => "EwcSepoliaE2eWallet" };
  const phantomProvider = {
    isPhantom: true,
    publicKey,
    connect: async () => ({ publicKey }),
    disconnect: async () => {},
    signMessage: async (message: Uint8Array) => {
      if (!walletPrivateKey) {
        throw new Error("installPhantom: no signing key installed (public tier does not sign).");
      }
      return {
        signature: new Uint8Array(ed25519Sign(null, message, walletPrivateKey)),
        publicKey,
      };
    },
    signAndSendTransaction: async () => ({ signature: "unused" }),
    on: () => {},
    removeListener: () => {},
  };
  (globalThis as { window?: unknown }).window = { phantom: { solana: phantomProvider } };
}

/** STRK balance of `address` via a raw balanceOf call — no extra deps, no ABI. */
export async function strkBalance(
  provider: CallContractProvider,
  address: string,
): Promise<bigint> {
  const [low, high] = await provider.callContract({
    contractAddress: STRK_ADDRESS,
    // balanceOf (camelCase) is the STRK token's snapshot-interface selector — the only
    // camelCase selector in this file (Cairo entrypoints are otherwise snake_case).
    entrypoint: "balanceOf",
    calldata: [address],
  });
  return BigInt(low) + (BigInt(high) << 128n);
}

/** transfer(recipient, amount: u256) as a ready-to-execute Call. */
export function strkTransfer(recipient: string, amount: bigint): Call {
  return {
    contractAddress: STRK_ADDRESS,
    entrypoint: "transfer",
    calldata: CallData.compile({ recipient, amount: cairo.uint256(amount) }),
  };
}

/** SRC5 supports_interface(interfaceId) → boolean, via a raw call. */
export async function supportsInterface(
  provider: CallContractProvider,
  address: string,
  interfaceId: string,
): Promise<boolean> {
  const [supportsInterfaceResult] = await provider.callContract({
    contractAddress: address,
    entrypoint: "supports_interface",
    calldata: [interfaceId],
  });
  return BigInt(supportsInterfaceResult) === 1n;
}
