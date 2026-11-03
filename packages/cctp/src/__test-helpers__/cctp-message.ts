// Test-only helpers for crafting CCTP V2 burn messages at their byte offsets.
// This module deliberately lives outside the `*.test.ts` glob so vitest does
// not collect it as a suite; it is imported by bridge.test.ts and
// bridge.recovery.test.ts to share the message-crafting logic.

export interface CctpMessageFields {
  destDomain: number;
  nonce: bigint;
  mintRecipient: bigint;
  amount: bigint;
}

// Write a big-endian bigint into `len` bytes.
export const beBytes = (value: bigint, len: number): Uint8Array => {
  const bytes = new Uint8Array(len);
  let remaining = value;
  for (let byteIndex = len - 1; byteIndex >= 0; byteIndex--) {
    bytes[byteIndex] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
};

// Craft a minimal 248-byte CCTP V2 message with known fields at their offsets:
// dest_domain [8,12), nonce [12,44), mint_recipient [184,216), amount [216,248).
export const craftMessageBytes = (fields: CctpMessageFields): Uint8Array => {
  const msg = new Uint8Array(248);
  msg.set(beBytes(BigInt(fields.destDomain), 4), 8);
  msg.set(beBytes(fields.nonce, 32), 12);
  msg.set(beBytes(fields.mintRecipient, 32), 184);
  msg.set(beBytes(fields.amount, 32), 216);
  return msg;
};

// Hex-encoded form of craftMessageBytes (the shape Circle's attestation API returns).
export const craftMessageHex = (fields: CctpMessageFields): string =>
  "0x" +
  Array.from(craftMessageBytes(fields), (byte) => byte.toString(16).padStart(2, "0")).join("");

// A `complete` Circle message envelope wrapping a crafted BurnMessage.
export const completeMessage = (fields: CctpMessageFields, attestation = "0xa11e57") => ({
  status: "complete",
  message: craftMessageHex(fields),
  attestation,
  eventNonce: "0x" + fields.nonce.toString(16),
});
