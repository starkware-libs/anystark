import { describe, expect, it } from "vitest";
import { buildEddsaSignatureFelts } from "./garaga";
import { assembleSignedMessage } from "./signer";
import {
  LOCKED_HASH_HEX,
  LOCKED_LABEL,
  LOCKED_PUBKEY,
  LOCKED_SIG64,
  LOCKED_SIG64_LABELED,
} from "./test_vectors";

// ─── Locked TS↔Cairo signature-bundle vectors ───
// Real Ed25519 signatures (signer = seed 0..31) over the base64 message form. The
// no-label EXPECTED_FELTS is byte-identical to sig1() in
// packages/contracts/src/test_sol_account.cairo (valid_signature_passes deserializes
// this exact bundle and asserts the on-chain garaga verifier returns 'VALID'), and
// EXPECTED_FELTS_LABELED matches sig1_labeled() there. The copies are kept in sync by
// hand (regenerate via gen_contract_vectors.mjs), so together they lock the off-chain
// (TS/WASM) → on-chain (Cairo) signature encoding end-to-end, for both the no-label and
// the readable-label paths.
const PUBKEY = LOCKED_PUBKEY;
const MSG = assembleSignedMessage(LOCKED_HASH_HEX);
const MSG_LABELED = assembleSignedMessage(LOCKED_HASH_HEX, LOCKED_LABEL);

// prettier-ignore
const EXPECTED_FELTS = [
  "0x89e728eb2b0b1b9bacf641b1a583ef52", "0x8dc3707c1b1beed1ce9233112d2edb3d", "0xe335bd8fd781a83e86dd138b84a8a435", "0x2b44e0dc38fa4ce0a833f01d1c9e7cb", "0x2c", "0x41", "0x42", "0x6f", "0x72", "0x50", "0x45", "0x31", "0x65", "0x62", "0x33", "0x43", "0x42", "0x6b", "0x70", "0x4f", "0x6b", "0x74", "0x63", "0x62", "0x58", "0x36", "0x50", "0x6b", "0x4b", "0x47", "0x79", "0x77", "0x39", "0x54", "0x6c", "0x39", "0x67", "0x63", "0x59", "0x4b", "0x54", "0x70", "0x4c", "0x58", "0x47", "0x31", "0x2b", "0x67", "0x3d", "0x14", "0xbb47013d92a599345834a422", "0x19a7288136520d2e679eb7be", "0x2ef3f19d1d01bc5", "0x0", "0x9c676d3acc465b792a29b91b", "0x9f42c18ab28d1c0a9412ece4", "0x5409a8346f542f3a", "0x0", "0x25b7d652fba2869d4ca134d92f217285", "0x119d8f39d4187e900681bbe109d458760", "0xe885ebe4dc616353180683eb", "0x12aa23dc48341c10084caa4", "0x2ff50558bfc791cb", "0x0", "0xb593a2a998bcd541a44cf8f8", "0xdb0edfccf2f56c00b2490856", "0x7c7e22b5c2ac250d", "0x0", "0x1555a4839dacbe6aaddff9f6afc6e578", "0x1141a76675877aa44c826f3da912e8105", "0xa0dbae440d3b2a7f56b0e39cfd041659", "0xf62118d9e870bef3decd656a6a857d7", "0xc95fb5a1cbb999c4629a4836155d1d73", "0x22f0627bcb72c7ea8aa709cdce7618d3",
];

// prettier-ignore
const EXPECTED_FELTS_LABELED = [
  "0x32776b3325c9957d3d886b74a796ccd3", "0xcf49b2ad6cc03e22d5caa3a8b52673c0", "0xf4434f1831d31ad37a8d8e79f4769fa7", "0x892ea9656175c9327b958b0cbac88ed", "0x55", "0x61", "0x6e", "0x79", "0x73", "0x74", "0x61", "0x72", "0x6b", "0x3a", "0x20", "0x74", "0x72", "0x61", "0x6e", "0x73", "0x66", "0x65", "0x72", "0x20", "0x32", "0x35", "0x20", "0x55", "0x53", "0x44", "0x43", "0x20", "0x74", "0x6f", "0x20", "0x61", "0x6c", "0x69", "0x63", "0x65", "0x2e", "0x73", "0x74", "0x72", "0x6b", "0xa", "0x41", "0x42", "0x6f", "0x72", "0x50", "0x45", "0x31", "0x65", "0x62", "0x33", "0x43", "0x42", "0x6b", "0x70", "0x4f", "0x6b", "0x74", "0x63", "0x62", "0x58", "0x36", "0x50", "0x6b", "0x4b", "0x47", "0x79", "0x77", "0x39", "0x54", "0x6c", "0x39", "0x67", "0x63", "0x59", "0x4b", "0x54", "0x70", "0x4c", "0x58", "0x47", "0x31", "0x2b", "0x67", "0x3d", "0x14", "0xbe412d284dcd7607ad10ce5b", "0x6d8dfd2ad770f34819f4ab70", "0x6c3e3315d5cfb359", "0x0", "0x1e6282a239361c4b3cf77b6c", "0x3e1b42c5fe22c9616a13a51c", "0x5ef8d6570eaacf82", "0x0", "0x2237f9d0d4a229c90c34ce992912f02", "0x295ca53eb5aefc81ebeffde47a923555", "0xd004d199c20bd032a2e596d4", "0x41ce28b3c218d28982dbd73e", "0x2abde6772cad5537", "0x0", "0x9cfe19c0a8ee3136009ed4f5", "0xcbb8d0e0e2467e378ed2be35", "0x1953290e1d52f537", "0x0", "0x31a23b5bad2fbac930b7d6362e5379f9", "0x11c630377c23f58740c21cb7555ba640b", "0x2c83f053624fd1488cad48eec01f8f7", "0x25f0ac23e7080d87dc4a422476c6cbd2", "0xc95fb5a1cbb999c4629a4836155d1d73", "0x22f0627bcb72c7ea8aa709cdce7618d3",
];

describe("buildEddsaSignatureFelts", () => {
  it("produces the locked NO-LABEL felt bundle the sol_account contract verifies", async () => {
    const felts = await buildEddsaSignatureFelts(PUBKEY, LOCKED_SIG64, MSG);
    expect(felts).toEqual(EXPECTED_FELTS);
    expect(felts[4]).toBe("0x2c"); // msg_len = 44 (the base64 hash, one SHA-512 block)
  });

  it("produces the locked LABELED felt bundle (label + '\\n' + base64 hash)", async () => {
    const felts = await buildEddsaSignatureFelts(PUBKEY, LOCKED_SIG64_LABELED, MSG_LABELED);
    expect(felts).toEqual(EXPECTED_FELTS_LABELED);
    expect(felts[4]).toBe("0x55"); // msg_len = 85 (40-byte label + '\n' + 44-byte base64)
  });

  it("rejects a signature that is not 64 bytes", async () => {
    await expect(buildEddsaSignatureFelts(PUBKEY, new Uint8Array(63), MSG)).rejects.toThrow();
  });

  it("rejects a pubkey that is not 32 bytes", async () => {
    await expect(buildEddsaSignatureFelts(new Uint8Array(31), LOCKED_SIG64, MSG)).rejects.toThrow();
  });
});
