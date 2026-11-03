import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CctpBridge } from "./bridge";
import { CCTP_TESTNET_CONFIG } from "./config";

// A well-formed Solana burn signature: 64 bytes is 86-88 base58 characters.
const BASE58_SIG =
  "3AsE6nZBbpDrEBBqjSqSTBbSDBiTxvvXumhFsGNCGyPspEEHfmCUx1WLmUJRp8CgAQeGL4kQQPvXWaRVTPuQjZR1";
const HEX_HASH = "0x0123456789abcdefABCDEF0123456789abcdefABCDEF0123456789abcdef0123";

const SOLANA_DOMAIN = CCTP_TESTNET_CONFIG.solana.domain;
const STARKNET_DOMAIN = CCTP_TESTNET_CONFIG.starknet.domain;

const bridge = new CctpBridge(CCTP_TESTNET_CONFIG);
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(
    async () => ({ ok: true, json: async () => ({ messages: [] }) }) as unknown as Response,
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("fetchAttestation identifier validation (chain-shaped: base58 for Solana, 0x hex elsewhere)", () => {
  it("accepts a base58 burn signature for the Solana domain and queries Circle with it", async () => {
    const res = await bridge.fetchAttestation(SOLANA_DOMAIN, BASE58_SIG);
    expect(res.status).toBe("pending_confirmations");
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname.endsWith(`/v2/messages/${SOLANA_DOMAIN}`)).toBe(true);
    expect(url.searchParams.get("transactionHash")).toBe(BASE58_SIG);
  });

  it("accepts a 0x hex burn tx hash for the Starknet domain", async () => {
    await bridge.fetchAttestation(STARKNET_DOMAIN, HEX_HASH);
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get("transactionHash")).toBe(HEX_HASH);
  });

  it("rejects a hex hash on the Solana domain (a Solana burn is keyed by its signature)", async () => {
    await expect(bridge.fetchAttestation(SOLANA_DOMAIN, HEX_HASH)).rejects.toThrow(
      /invalid burn tx signature/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a base58 signature on a hex-keyed domain", async () => {
    await expect(bridge.fetchAttestation(STARKNET_DOMAIN, BASE58_SIG)).rejects.toThrow(
      /invalid burn tx hash/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["query-meaningful characters", "abc&injected=1"],
    ["path traversal", "../5/messages"],
    ["whitespace", `${HEX_HASH} `],
    ["base58-excluded characters (0, O, I, l)", "0OIl".repeat(22)],
    ["a too-short base58 string", "3AsE6nZBbpDr"],
    ["an empty string", ""],
  ])("rejects %s before any network call", async (_name, bad) => {
    await expect(bridge.fetchAttestation(SOLANA_DOMAIN, bad)).rejects.toThrow(/invalid burn tx/);
    await expect(bridge.fetchAttestation(STARKNET_DOMAIN, bad)).rejects.toThrow(/invalid burn tx/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the attested message once Circle reports complete", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        messages: [
          { status: "complete", message: "0xdead", attestation: "0xbeef", eventNonce: "7" },
        ],
      }),
    } as unknown as Response);
    const res = await bridge.fetchAttestation(SOLANA_DOMAIN, BASE58_SIG);
    expect(res).toEqual({
      status: "complete",
      message: "0xdead",
      attestation: "0xbeef",
      eventNonce: "7",
    });
  });
});
