// Characterization tests for solanaUsdcBalance's error handling: a missing ATA
// (RPC "could not find account", SolanaJSONRPCError code -32602) reads as a
// zero balance, but any other error (403/rate-limit/network) is a transport
// failure and must reject, not masquerade as "0 USDC". See bridge.ts.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { CctpBridge } from "./bridge";
import { CCTP_TESTNET_CONFIG } from "./config";

const chain = vi.hoisted(() => {
  return {
    getTokenAccountBalance: undefined as unknown as Mock<(...args: unknown[]) => unknown>,
  };
});

vi.mock("@solana/web3.js", () => {
  class PublicKey {
    value: unknown;
    constructor(value: unknown) {
      this.value = value;
    }
  }
  class Connection {
    getTokenAccountBalance(...args: unknown[]) {
      return chain.getTokenAccountBalance(...args);
    }
  }
  // Mirrors the real web3.js shape: a JSON-RPC error wrapped with a `code`,
  // thrown by Connection methods when the RPC responds with a JSON-RPC error.
  class SolanaJSONRPCError extends Error {
    code: unknown;
    constructor({ code, message }: { code: unknown; message: string }) {
      super(message);
      this.code = code;
      this.name = "SolanaJSONRPCError";
    }
  }
  return { PublicKey, Connection, SolanaJSONRPCError };
});

vi.mock("@solana/spl-token", () => {
  return {
    getAssociatedTokenAddress: async () => ({ toBase58: () => "ata" }),
  };
});

const bridge = new CctpBridge(CCTP_TESTNET_CONFIG);
const OWNER = "SolanaOwnerPubkey";

beforeEach(() => {
  chain.getTokenAccountBalance = vi.fn();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("solanaUsdcBalance", () => {
  it("reads 0n when the RPC reports the ATA doesn't exist (missing-account SolanaJSONRPCError)", async () => {
    const { SolanaJSONRPCError } = await import("@solana/web3.js");
    chain.getTokenAccountBalance.mockRejectedValue(
      new SolanaJSONRPCError({ code: -32602, message: "Invalid param: could not find account" }),
    );
    await expect(bridge.solanaUsdcBalance(OWNER)).resolves.toBe(0n);
  });

  it("rethrows a transport failure (403/rate-limit) instead of reporting 0", async () => {
    chain.getTokenAccountBalance.mockRejectedValue(new Error("403 Forbidden"));
    await expect(bridge.solanaUsdcBalance(OWNER)).rejects.toThrow("403 Forbidden");
  });

  it("rethrows a same-shaped SolanaJSONRPCError with a different code (not the missing-account case)", async () => {
    const { SolanaJSONRPCError } = await import("@solana/web3.js");
    await expect(
      (async () => {
        chain.getTokenAccountBalance.mockRejectedValue(
          new SolanaJSONRPCError({ code: -32000, message: "could not find account" }),
        );
        return bridge.solanaUsdcBalance(OWNER);
      })(),
    ).rejects.toThrow();
  });

  it("happy path: returns the parsed raw balance unchanged", async () => {
    chain.getTokenAccountBalance.mockResolvedValue({ value: { amount: "1500000" } });
    await expect(bridge.solanaUsdcBalance(OWNER)).resolves.toBe(1_500_000n);
  });
});
