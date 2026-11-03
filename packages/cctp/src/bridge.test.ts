import { describe, expect, it } from "vitest";
import { uint256 } from "starknet";
import { CctpBridge, parseCctpBurnMessage } from "./bridge";
import { CCTP_TESTNET_CONFIG } from "./config";
import { beBytes, craftMessageBytes } from "./__test-helpers__/cctp-message";

const bridge = new CctpBridge(CCTP_TESTNET_CONFIG);

describe("CctpBridge call builders (pure, no network)", () => {
  it("buildWithdrawToSolanaCalls: approve + deposit_for_burn to the Solana domain", () => {
    const ata = new Uint8Array(32).fill(7);
    const calls = bridge.buildWithdrawToSolanaCalls(1_000_000n, ata);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      contractAddress: CCTP_TESTNET_CONFIG.starknet.usdc,
      entrypoint: "approve",
    });
    expect(calls[1]).toMatchObject({
      contractAddress: CCTP_TESTNET_CONFIG.starknet.tokenMessenger,
      entrypoint: "deposit_for_burn",
    });
    // deposit_for_burn calldata is non-empty (amount u256, domain, recipient, …).
    expect(calls[1].calldata?.length).toBeGreaterThan(0);
  });

  it("buildWithdrawToSolanaCalls rejects a non-32-byte recipient", () => {
    expect(() => bridge.buildWithdrawToSolanaCalls(1n, new Uint8Array(31))).toThrow();
  });

  it("buildWithdrawToOwnerCalls derives the owner USDC ATA and targets it in the burn calls", async () => {
    // A valid, on-curve ed25519 wallet pubkey (from Keypair.generate()).
    // getAssociatedTokenAddress requires an on-curve owner and throws
    // TokenOwnerOffCurveError otherwise, so this must stay a real wallet key.
    const ownerPubkey = "BRauHbiQd1WXY8E5y6aVf5Qf6T8HBd2jFERUxNuHZ1XA";
    const derivedAta = await bridge.solanaUsdcAtaBytes(ownerPubkey);
    const expected = bridge.buildWithdrawToSolanaCalls(1_000_000n, derivedAta);
    const actual = await bridge.buildWithdrawToOwnerCalls(1_000_000n, ownerPubkey);
    expect(actual).toEqual(expected);

    // Pin the actual recipient: deposit_for_burn (calls[1]) must carry the derived
    // ATA as its mint_recipient u256. bytes32 big-endian -> bigint mirrors
    // solanaAddrToU256 in bridge.ts; CallData.compile serializes the limbs as
    // decimal strings, so compare against the decimal form.
    const ataToU256 = (ata: Uint8Array) => ata.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
    const mintRecipient = uint256.bnToUint256(ataToU256(derivedAta));
    const burnCalldata = actual[1].calldata as string[];
    expect(burnCalldata).toContain(BigInt(mintRecipient.low).toString());
    expect(burnCalldata).toContain(BigInt(mintRecipient.high).toString());
  });

  it("buildWithdrawToOwnerCalls rejects an invalid base58 pubkey", async () => {
    await expect(
      bridge.buildWithdrawToOwnerCalls(1_000_000n, "not-a-valid-base58-pubkey"),
    ).rejects.toThrow();
  });

  it("buildReceiveOnStarknetCall: receive_message with two ByteArray args", () => {
    // message = 1 byte (0xaa), attestation = 1 byte (0xbb). Each encodes as a
    // ByteArray: [data_len=0, pending_word, pending_len=1].
    const call = bridge.buildReceiveOnStarknetCall("0xaa", "0xbb");
    expect(call).toMatchObject({
      contractAddress: CCTP_TESTNET_CONFIG.starknet.messageTransmitter,
      entrypoint: "receive_message",
    });
    expect(call.calldata).toEqual(["0", "0xaa", "1", "0", "0xbb", "1"]);
  });

  it("buildReceiveOnStarknetCall: exact 31-byte boundary packs one full word, no pending", () => {
    // 31 bytes 0x01..0x1f -> ByteArray [data_len=1, word31, pending=0x0, pending_len=0].
    const word31 = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
    const call = bridge.buildReceiveOnStarknetCall("0x" + word31, "0xbb");
    expect(call.calldata).toEqual([
      "1",
      "0x102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
      "0x0",
      "0",
      "0",
      "0xbb",
      "1",
    ]);
  });

  it("buildReceiveOnStarknetCall: multi-word message packs full 31-byte words + pending remainder", () => {
    // 35 bytes 0x01..0x23 -> one full 31-byte word + a 4-byte pending word.
    // ByteArray = [data_len=1, word31, pending=0x20212223, pending_len=4].
    const msg35 = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20212223";
    const call = bridge.buildReceiveOnStarknetCall("0x" + msg35, "0xbb");
    expect(call.calldata).toEqual([
      "1",
      "0x102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
      "0x20212223",
      "4",
      "0",
      "0xbb",
      "1",
    ]);
  });
});

describe("parseCctpBurnMessage (fund-critical CCTP V2 field parsing)", () => {
  it("extracts dest-domain, nonce, mint_recipient, and amount at the V2 offsets", () => {
    const nonce = 0x1122334455667788n;
    const mintRecipient = 0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789n;
    const amount = 1_500_000n;
    const fields = parseCctpBurnMessage(
      craftMessageBytes({ destDomain: 5, nonce, mintRecipient, amount }),
    );
    expect(fields).not.toBeNull();
    expect(fields!.destDomain).toBe(5);
    expect(fields!.nonce).toBe(nonce);
    expect(fields!.mintRecipient).toBe(mintRecipient);
    expect(fields!.amount).toBe(amount);
    // nonceBytes is the raw big-endian [12,44) slice used as the Solana PDA seed.
    expect(Array.from(fields!.nonceBytes)).toEqual(Array.from(beBytes(nonce, 32)));
  });

  it("keeps adjacent fields distinct (offsets don't overlap or bleed)", () => {
    const fields = parseCctpBurnMessage(
      craftMessageBytes({ destDomain: 0, nonce: 1n, mintRecipient: 2n, amount: 3n }),
    );
    expect(fields).toMatchObject({ destDomain: 0, nonce: 1n, mintRecipient: 2n, amount: 3n });
  });

  it("returns null for a message shorter than the minimum layout length", () => {
    expect(parseCctpBurnMessage(new Uint8Array(247))).toBeNull();
  });

  it("accepts a message exactly at the minimum length (248 bytes)", () => {
    expect(parseCctpBurnMessage(new Uint8Array(248))).not.toBeNull();
  });
});
