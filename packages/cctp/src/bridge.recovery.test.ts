// Characterization tests for the CCTP in-flight recovery scans
// (`findRecoverableDeposits` / `findRecoverableWithdrawals`). These LOCK the
// CURRENT observable behavior of this fund-adjacent recovery logic so a future
// batching/perf refactor has a regression safety net. They intentionally do NOT
// assert on performance or concurrency (there is none yet — the Circle +
// nonce lookups run sequentially on purpose).
//
// The network is fully mocked: Circle's attestation API via a stubbed global
// `fetch`, the Solana `@solana/web3.js` connection (getSignaturesForAddress /
// getAccountInfo) and `@solana/spl-token` (getAssociatedTokenAddress), and the
// Starknet `RpcProvider` (callContract / getEvents / getBlockNumber). The
// `starknet` mock is a PARTIAL mock: only `RpcProvider` is replaced, so
// `CallData`, `uint256`, `hash`, and `num` stay real (the production code uses
// them to build calldata / selectors during the scan).

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { CctpBridge } from "./bridge";
import { CCTP_TESTNET_CONFIG } from "./config";
import { beBytes, completeMessage, craftMessageHex } from "./__test-helpers__/cctp-message";

// Shared mock state the mocked modules delegate into. Declared via vi.hoisted so
// the (hoisted) vi.mock factories below can reference it. Reset in beforeEach.
const chain = vi.hoisted(() => {
  return {
    getSignaturesForAddress: undefined as unknown as Mock<(...args: unknown[]) => unknown>,
    getAccountInfo: undefined as unknown as Mock<(...args: unknown[]) => unknown>,
    callContract: undefined as unknown as Mock<(...args: unknown[]) => unknown>,
    getEvents: undefined as unknown as Mock<(...args: unknown[]) => unknown>,
    getBlockNumber: undefined as unknown as Mock<(...args: unknown[]) => unknown>,
    // Bytes returned by the mocked getAssociatedTokenAddress().toBytes(); drives
    // the withdrawal recipient filter (recipientTarget = beToBig(theseBytes)).
    ataBytes: new Uint8Array(32) as Uint8Array,
  };
});

vi.mock("@solana/web3.js", () => {
  class PublicKey {
    value: unknown;
    constructor(value: unknown) {
      this.value = value;
    }
    toBuffer() {
      return Buffer.from(String(this.value));
    }
    toBytes() {
      return chain.ataBytes;
    }
    toBase58() {
      return "pk:" + String(this.value);
    }
    // findPda() calls this for the used_nonce PDA (programId is the 2nd arg,
    // ignored here). Encode the seeds into the returned key's `value` so the
    // getAccountInfo mock can key off the nonce.
    static findProgramAddressSync(seeds: Uint8Array[]) {
      const seedHex = seeds.map((s) => Buffer.from(s).toString("hex")).join("-");
      return [new PublicKey("pda:" + seedHex)];
    }
  }
  class Connection {
    getSignaturesForAddress(...args: unknown[]) {
      return chain.getSignaturesForAddress(...args);
    }
    getAccountInfo(...args: unknown[]) {
      return chain.getAccountInfo(...args);
    }
  }
  return { PublicKey, Connection };
});

vi.mock("@solana/spl-token", () => {
  return {
    getAssociatedTokenAddress: async () => ({
      toBytes: () => chain.ataBytes,
      toBase58: () => "ata",
    }),
    TOKEN_PROGRAM_ID: { toBase58: () => "tokenprog" },
  };
});

vi.mock("starknet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("starknet")>();
  class RpcProvider {
    callContract(...args: unknown[]) {
      return chain.callContract(...args);
    }
    getBlockNumber(...args: unknown[]) {
      return chain.getBlockNumber(...args);
    }
    getEvents(...args: unknown[]) {
      return chain.getEvents(...args);
    }
  }
  return { ...actual, RpcProvider };
});

const SN_DOMAIN = CCTP_TESTNET_CONFIG.starknet.domain; // 25
const SOL_DOMAIN = CCTP_TESTNET_CONFIG.solana.domain; // 5

// Per-tx Circle fetch behavior, keyed by transactionHash. A value of "throw"
// makes fetch reject; { ok: false } makes it return a non-ok Response (e.g. 429);
// { messages } returns an ok Response with that messages array.
type CircleSpec = "throw" | { ok: false; status?: number } | { messages: unknown[] };
let circleResponses: Map<string, CircleSpec>;

const bridge = new CctpBridge(CCTP_TESTNET_CONFIG);

beforeEach(() => {
  chain.getSignaturesForAddress = vi.fn();
  chain.getAccountInfo = vi.fn();
  chain.callContract = vi.fn();
  chain.getEvents = vi.fn();
  chain.getBlockNumber = vi.fn(async () => 5_000_000);
  chain.ataBytes = new Uint8Array(32);

  circleResponses = new Map();
  const fetchMock = vi.fn(async (url: string) => {
    const txHash = new URL(url).searchParams.get("transactionHash") ?? "";
    const spec = circleResponses.get(txHash);
    if (!spec) return { ok: true, json: async () => ({ messages: [] }) } as unknown as Response;
    if (spec === "throw") throw new Error("Circle network error");
    if ("ok" in spec) return { ok: false, status: spec.status ?? 500 } as unknown as Response;
    return { ok: true, json: async () => ({ messages: spec.messages }) } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("findRecoverableDeposits (Solana→Starknet burns awaiting a Starknet receive)", () => {
  const RECIPIENT = "0x1234";
  const SOLANA_OWNER = "SolanaOwnerPubkey";

  it("returns candidates in signature-history order (newest-first, as getSignaturesForAddress yields)", async () => {
    // getSignaturesForAddress returns newest-first; a single sub-page-size page
    // ends the scan. The result must preserve that order.
    chain.getSignaturesForAddress.mockResolvedValue([
      { signature: "sigNewest" },
      { signature: "sigOlder" },
    ]);
    circleResponses.set("sigNewest", {
      messages: [
        completeMessage({ destDomain: SN_DOMAIN, nonce: 1n, mintRecipient: 0x1234n, amount: 10n }),
      ],
    });
    circleResponses.set("sigOlder", {
      messages: [
        completeMessage({ destDomain: SN_DOMAIN, nonce: 2n, mintRecipient: 0x1234n, amount: 20n }),
      ],
    });
    chain.callContract.mockResolvedValue(["0x0"]); // nonce never used → keep both

    const out = await bridge.findRecoverableDeposits(SOLANA_OWNER, RECIPIENT);

    expect(out.map((d) => d.burnSig)).toEqual(["sigNewest", "sigOlder"]);
    expect(out.map((d) => d.amount)).toEqual([10n, 20n]);
  });

  it("filters out wrong dest-domain, wrong mint_recipient, and non-complete messages", async () => {
    chain.getSignaturesForAddress.mockResolvedValue([
      { signature: "sigWrongDomain" },
      { signature: "sigWrongRecipient" },
      { signature: "sigPending" },
      { signature: "sigMatch" },
    ]);
    circleResponses.set("sigWrongDomain", {
      messages: [
        completeMessage({ destDomain: 99, nonce: 1n, mintRecipient: 0x1234n, amount: 1n }),
      ],
    });
    circleResponses.set("sigWrongRecipient", {
      messages: [
        completeMessage({ destDomain: SN_DOMAIN, nonce: 2n, mintRecipient: 0xdeadn, amount: 2n }),
      ],
    });
    circleResponses.set("sigPending", {
      messages: [
        {
          status: "pending_confirmations",
          message: craftMessageHex({
            destDomain: SN_DOMAIN,
            nonce: 3n,
            mintRecipient: 0x1234n,
            amount: 3n,
          }),
          attestation: null,
          eventNonce: null,
        },
      ],
    });
    circleResponses.set("sigMatch", {
      messages: [
        completeMessage({ destDomain: SN_DOMAIN, nonce: 4n, mintRecipient: 0x1234n, amount: 4n }),
      ],
    });
    chain.callContract.mockResolvedValue(["0x0"]);

    const out = await bridge.findRecoverableDeposits(SOLANA_OWNER, RECIPIENT);

    expect(out.map((d) => d.burnSig)).toEqual(["sigMatch"]);
  });

  it("excludes deposits whose nonce is already used on Starknet (is_nonce_used != 0)", async () => {
    chain.getSignaturesForAddress.mockResolvedValue([
      { signature: "sigUnused" },
      { signature: "sigUsed" },
    ]);
    circleResponses.set("sigUnused", {
      messages: [
        completeMessage({ destDomain: SN_DOMAIN, nonce: 1n, mintRecipient: 0x1234n, amount: 1n }),
      ],
    });
    circleResponses.set("sigUsed", {
      messages: [
        completeMessage({ destDomain: SN_DOMAIN, nonce: 2n, mintRecipient: 0x1234n, amount: 2n }),
      ],
    });
    // Sequential scan → is_nonce_used is called once per candidate in sig order:
    // first (sigUnused) → 0x0 (kept), second (sigUsed) → 0x1 (already minted, dropped).
    chain.callContract.mockResolvedValueOnce(["0x0"]).mockResolvedValueOnce(["0x1"]);

    const out = await bridge.findRecoverableDeposits(SOLANA_OWNER, RECIPIENT);

    expect(out.map((d) => d.burnSig)).toEqual(["sigUnused"]);
  });

  it("falls through and KEEPS the deposit when is_nonce_used errors (recover-attempt estimate guards it)", async () => {
    // Locks the is_nonce_used try/catch: a failing nonce check must NOT drop a
    // candidate — the deposit is still surfaced for a recover attempt.
    chain.getSignaturesForAddress.mockResolvedValue([{ signature: "sigErr" }]);
    circleResponses.set("sigErr", {
      messages: [
        completeMessage({ destDomain: SN_DOMAIN, nonce: 7n, mintRecipient: 0x1234n, amount: 42n }),
      ],
    });
    chain.callContract.mockRejectedValue(new Error("rpc down"));

    const out = await bridge.findRecoverableDeposits(SOLANA_OWNER, RECIPIENT);

    expect(out.map((d) => d.burnSig)).toEqual(["sigErr"]);
    expect(out[0].amount).toBe(42n);
  });

  it("CURRENT (accepted-for-now) behavior: a Circle fetch failure silently drops the burn (empty-on-failure)", async () => {
    // circleMessages swallows both a thrown fetch and a non-ok Response (e.g.
    // Circle 429 rate-limit) by returning []. The affected burn is then silently
    // omitted from the results. This is the DEFERRED error-contract concern; the
    // test LOCKS the drop so a future refactor that changes it fails loudly.
    chain.getSignaturesForAddress.mockResolvedValue([
      { signature: "sigThrows" },
      { signature: "sig429" },
      { signature: "sigOk" },
    ]);
    circleResponses.set("sigThrows", "throw");
    circleResponses.set("sig429", { ok: false, status: 429 });
    circleResponses.set("sigOk", {
      messages: [
        completeMessage({ destDomain: SN_DOMAIN, nonce: 1n, mintRecipient: 0x1234n, amount: 5n }),
      ],
    });
    chain.callContract.mockResolvedValue(["0x0"]);

    const out = await bridge.findRecoverableDeposits(SOLANA_OWNER, RECIPIENT);

    // Only the successful lookup survives; the throw and the 429 are dropped.
    expect(out.map((d) => d.burnSig)).toEqual(["sigOk"]);
  });

  it("pages the signature history with a `before` cursor and finds a match on the SECOND page", async () => {
    // DEPOSIT_SCAN_SIGNATURE_PAGE = 1000: a full first page (length === page size)
    // keeps the loop going with `before` set to the last signature; a shorter
    // second page ends it. The recoverable burn lives on page 2, so it is only
    // found if the loop actually advances the cursor past page 1.
    const firstPage = Array.from({ length: 1000 }, (_unused, index) => ({
      signature: `page1-sig-${index}`,
    }));
    const lastSigOfFirstPage = firstPage[firstPage.length - 1].signature;
    chain.getSignaturesForAddress
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([{ signature: "sigPage2" }]);
    circleResponses.set("sigPage2", {
      messages: [
        completeMessage({ destDomain: SN_DOMAIN, nonce: 1n, mintRecipient: 0x1234n, amount: 7n }),
      ],
    });
    chain.callContract.mockResolvedValue(["0x0"]); // nonce never used → keep it

    const out = await bridge.findRecoverableDeposits(SOLANA_OWNER, RECIPIENT);

    expect(out.map((d) => d.burnSig)).toEqual(["sigPage2"]);
    expect(out.map((d) => d.amount)).toEqual([7n]);
    expect(chain.getSignaturesForAddress).toHaveBeenCalledTimes(2);
    // The second-page request carries the `before` cursor = last sig of page 1.
    expect(chain.getSignaturesForAddress).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ before: lastSigOfFirstPage }),
    );
  });
});

describe("findRecoverableWithdrawals (Starknet→Solana burns awaiting a Solana receive)", () => {
  const SENDER = "0x5678";
  const SOLANA_OWNER = "SolanaOwnerPubkey";
  // recipientTarget = beToBig(ataBytes); craft mint_recipient to match it.
  const RECIPIENT_TARGET = 0xabcdn;

  beforeEach(() => {
    chain.ataBytes = beBytes(RECIPIENT_TARGET, 32);
  });

  const singleEventPage = (txHashes: string[]) =>
    chain.getEvents.mockResolvedValue({
      events: txHashes.map((transaction_hash) => ({ transaction_hash })),
      continuation_token: undefined,
    });

  it("preserves getEvents order (oldest-first, ascending) without reordering — passthrough lock", async () => {
    // getEvents yields events oldest-first; the scan must not reorder them, so
    // the result mirrors the event order as-is. Locks the no-reorder passthrough.
    singleEventPage(["tx1", "tx2"]);
    circleResponses.set("tx1", {
      messages: [
        completeMessage({
          destDomain: SOL_DOMAIN,
          nonce: 1n,
          mintRecipient: RECIPIENT_TARGET,
          amount: 1n,
        }),
      ],
    });
    circleResponses.set("tx2", {
      messages: [
        completeMessage({
          destDomain: SOL_DOMAIN,
          nonce: 2n,
          mintRecipient: RECIPIENT_TARGET,
          amount: 2n,
        }),
      ],
    });
    chain.getAccountInfo.mockResolvedValue(null); // used_nonce PDA absent → keep both

    const out = await bridge.findRecoverableWithdrawals(SENDER, SOLANA_OWNER);

    expect(out.map((w) => w.starknetTx)).toEqual(["tx1", "tx2"]);
  });

  it("filters out wrong dest-domain, wrong mint_recipient, and non-complete messages", async () => {
    singleEventPage(["txWrongDomain", "txWrongRecipient", "txPending", "txMatch"]);
    circleResponses.set("txWrongDomain", {
      messages: [
        completeMessage({
          destDomain: 99,
          nonce: 1n,
          mintRecipient: RECIPIENT_TARGET,
          amount: 1n,
        }),
      ],
    });
    circleResponses.set("txWrongRecipient", {
      messages: [
        completeMessage({ destDomain: SOL_DOMAIN, nonce: 2n, mintRecipient: 0x9999n, amount: 2n }),
      ],
    });
    circleResponses.set("txPending", {
      messages: [
        {
          status: "pending_confirmations",
          message: craftMessageHex({
            destDomain: SOL_DOMAIN,
            nonce: 3n,
            mintRecipient: RECIPIENT_TARGET,
            amount: 3n,
          }),
          attestation: null,
          eventNonce: null,
        },
      ],
    });
    circleResponses.set("txMatch", {
      messages: [
        completeMessage({
          destDomain: SOL_DOMAIN,
          nonce: 4n,
          mintRecipient: RECIPIENT_TARGET,
          amount: 4n,
        }),
      ],
    });
    chain.getAccountInfo.mockResolvedValue(null);

    const out = await bridge.findRecoverableWithdrawals(SENDER, SOLANA_OWNER);

    expect(out.map((w) => w.starknetTx)).toEqual(["txMatch"]);
  });

  it("excludes withdrawals already minted on Solana (used_nonce PDA account exists)", async () => {
    singleEventPage(["txUsed", "txUnused"]);
    circleResponses.set("txUsed", {
      messages: [
        completeMessage({
          destDomain: SOL_DOMAIN,
          nonce: 1n,
          mintRecipient: RECIPIENT_TARGET,
          amount: 1n,
        }),
      ],
    });
    circleResponses.set("txUnused", {
      messages: [
        completeMessage({
          destDomain: SOL_DOMAIN,
          nonce: 2n,
          mintRecipient: RECIPIENT_TARGET,
          amount: 2n,
        }),
      ],
    });
    // Sequential scan in event order: first candidate's PDA exists (minted →
    // excluded), second's is absent (kept).
    chain.getAccountInfo.mockResolvedValueOnce({ lamports: 1 }).mockResolvedValueOnce(null);

    const out = await bridge.findRecoverableWithdrawals(SENDER, SOLANA_OWNER);

    expect(out.map((w) => w.starknetTx)).toEqual(["txUnused"]);
  });

  it("CURRENT (accepted-for-now) behavior: a Circle fetch failure silently drops the withdrawal (empty-on-failure)", async () => {
    // Same DEFERRED error-contract concern as deposits: circleMessages returns []
    // on a thrown fetch or a non-ok Response (Circle 429), so the affected burn is
    // silently omitted. Locked here so a future refactor changing it fails loudly.
    singleEventPage(["txThrows", "tx429", "txOk"]);
    circleResponses.set("txThrows", "throw");
    circleResponses.set("tx429", { ok: false, status: 429 });
    circleResponses.set("txOk", {
      messages: [
        completeMessage({
          destDomain: SOL_DOMAIN,
          nonce: 1n,
          mintRecipient: RECIPIENT_TARGET,
          amount: 5n,
        }),
      ],
    });
    chain.getAccountInfo.mockResolvedValue(null);

    const out = await bridge.findRecoverableWithdrawals(SENDER, SOLANA_OWNER);

    expect(out.map((w) => w.starknetTx)).toEqual(["txOk"]);
  });

  it("pages events with a `continuation_token`: burns from BOTH pages are processed", async () => {
    // The event scan loops while getEvents returns a continuation_token, feeding
    // it back on the next call. A token on page 1 (then undefined on page 2) must
    // drive a second request carrying that token, and page-2 events must also be
    // scanned — so a recoverable burn on either page is surfaced.
    chain.getEvents
      .mockResolvedValueOnce({
        events: [{ transaction_hash: "txPage1" }],
        continuation_token: "tokenA",
      })
      .mockResolvedValueOnce({
        events: [{ transaction_hash: "txPage2" }],
        continuation_token: undefined,
      });
    circleResponses.set("txPage1", {
      messages: [
        completeMessage({
          destDomain: SOL_DOMAIN,
          nonce: 1n,
          mintRecipient: RECIPIENT_TARGET,
          amount: 1n,
        }),
      ],
    });
    circleResponses.set("txPage2", {
      messages: [
        completeMessage({
          destDomain: SOL_DOMAIN,
          nonce: 2n,
          mintRecipient: RECIPIENT_TARGET,
          amount: 2n,
        }),
      ],
    });
    chain.getAccountInfo.mockResolvedValue(null);

    const out = await bridge.findRecoverableWithdrawals(SENDER, SOLANA_OWNER);

    expect(out.map((w) => w.starknetTx)).toEqual(["txPage1", "txPage2"]);
    expect(chain.getEvents).toHaveBeenCalledTimes(2);
    // The second event request carries the continuation_token from page 1.
    expect(chain.getEvents).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ continuation_token: "tokenA" }),
    );
  });

  it("dedupes a transaction_hash that repeats across pages: it is scanned once", async () => {
    // txHashes is a Set, so a burn tx that appears on both event pages collapses
    // to a single candidate — one Circle lookup, one used_nonce PDA check, one
    // result entry.
    chain.getEvents
      .mockResolvedValueOnce({
        events: [{ transaction_hash: "txDup" }],
        continuation_token: "tokenA",
      })
      .mockResolvedValueOnce({
        events: [{ transaction_hash: "txDup" }, { transaction_hash: "txOther" }],
        continuation_token: undefined,
      });
    circleResponses.set("txDup", {
      messages: [
        completeMessage({
          destDomain: SOL_DOMAIN,
          nonce: 1n,
          mintRecipient: RECIPIENT_TARGET,
          amount: 1n,
        }),
      ],
    });
    circleResponses.set("txOther", {
      messages: [
        completeMessage({
          destDomain: SOL_DOMAIN,
          nonce: 2n,
          mintRecipient: RECIPIENT_TARGET,
          amount: 2n,
        }),
      ],
    });
    chain.getAccountInfo.mockResolvedValue(null);

    const out = await bridge.findRecoverableWithdrawals(SENDER, SOLANA_OWNER);

    // txDup surfaces exactly once despite appearing on both pages.
    expect(out.map((w) => w.starknetTx)).toEqual(["txDup", "txOther"]);
    // Only the two unique candidates were checked (not three event entries).
    expect(chain.getAccountInfo).toHaveBeenCalledTimes(2);
  });
});
