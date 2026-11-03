#!/usr/bin/env node
// ─── sol_account signature-bundle vector generator ───
//
// Emits the locked garaga EdDSASignatureWithHint felt bundles the sol_account tests
// verify, for BOTH sides of the off-chain -> on-chain boundary:
//   - the Cairo `array!` literals in packages/contracts/src/test_sol_account.cairo
//     (sig1 / sig1_labeled / sig1_maxlabel / decoy_label_signature / sig2 /
//     msg_too_short_signature / msg_too_long_signature / hex_message_signature), and
//   - the TS hex arrays in packages/core/src/garaga.test.ts (EXPECTED_FELTS /
//     EXPECTED_FELTS_LABELED).
// Both come from the SAME real Ed25519 signatures and the SAME production encoder
// (@starkware-libs/anystark-core's buildEddsaSignatureFelts), so the two sides are byte-identical by
// construction and lock the encoding end to end.
//
// The garaga v1 bundle carries NO public key (the account verifies against its stored
// signer, passed to is_valid_eddsa_signature as Py_twisted), so the serialized felts
// are [Ry.low, Ry.high, s.low, s.high, msg_len, msg bytes…, msm_hint…, sqrt hints].
//
// Deterministic and re-runnable. Run from the repo root:
//   npm run -w @starkware-libs/anystark-core build
//   node packages/core/scripts/gen_contract_vectors.mjs
// then paste each emitted line/array over its counterpart in the two files. The
// SNIP-9 outside-execution vectors live in a separate generator (gen_snip9_vector.mjs).

/* global console, Buffer, TextEncoder */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assembleSignedMessage,
  buildEddsaSignatureFelts,
  feltToBase64Hash,
  MAX_LABEL_BYTES,
  MAX_MSG_LEN,
  pubkeyToU256Limbs,
} from "../dist/index.js"; // run `npm run -w @starkware-libs/anystark-core build` first

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");

// ─── the locked test key and message anchors, parsed from test_vectors.ts ───
const tv = fs.readFileSync(path.join(REPO, "packages/core/src/test_vectors.ts"), "utf8");
const LOCKED_PUBKEY = Uint8Array.from(
  tv
    .match(/LOCKED_PUBKEY = Uint8Array\.from\(\[([^\]]+)\]\)/)[1]
    .split(",")
    .map((s) => Number(s.trim())),
);
const LOCKED_HASH = BigInt(tv.match(/LOCKED_HASH = (0x[0-9a-fA-F]+)n;/)[1]);
const LOCKED_LABEL = tv.match(/LOCKED_LABEL = "([^"]*)";/)[1];
const HASH_HEX = "0x" + LOCKED_HASH.toString(16);
const B64_HASH = feltToBase64Hash(HASH_HEX);

const enc = new TextEncoder();

// An Ed25519 wallet backed by a raw 32-byte seed (PKCS8-wrapped for node:crypto).
// Test-only keys built from the public constant seeds below (bytes 0..31 and 1..32):
// the private halves are public knowledge by construction, which is what makes the
// locked vectors reproducible by any reviewer. Never fund an account derived from
// these keys; live e2e key material comes from EWC_E2E_* env vars instead.
function signerForSeed(seedBytes) {
  const pkcs8 = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"), // PKCS8 DER prefix for a raw seed
    Buffer.from(seedBytes),
  ]);
  const priv = crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const spki = crypto.createPublicKey(priv).export({ format: "der", type: "spki" });
  const pubkey = new Uint8Array(spki.subarray(spki.length - 32));
  return { pubkey, sign: (msg) => new Uint8Array(crypto.sign(null, Buffer.from(msg), priv)) };
}

// PK1 = seed bytes 0..31 (the repo's LOCKED_PUBKEY); PK2 = seed bytes 1..32.
const pk1 = signerForSeed(Uint8Array.from({ length: 32 }, (_, i) => i));
const pk2 = signerForSeed(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
if (Buffer.compare(Buffer.from(pk1.pubkey), Buffer.from(LOCKED_PUBKEY)) !== 0) {
  throw new Error("seed 0..31 pubkey != LOCKED_PUBKEY from packages/core");
}

// Build a bundle over an EXACT message (raw bytes), signed by `signer`. Used for the
// byte-level vectors (decoy, oversize, hex) the SDK's assembleSignedMessage refuses to
// emit (control chars in the label, over-long label).
async function bundleOverBytes(signer, msgBytes) {
  const msg = msgBytes instanceof Uint8Array ? msgBytes : enc.encode(msgBytes);
  const sig64 = signer.sign(msg);
  const felts = await buildEddsaSignatureFelts(signer.pubkey, sig64, msg);
  if (BigInt(felts[4]) !== BigInt(msg.length)) {
    throw new Error(`felts[4] (${felts[4]}) != msg length ${msg.length} - layout drift?`);
  }
  return { felts, msgLen: msg.length };
}

// Build a bundle over the assembled Phantom message form (optional readable label).
async function bundleOverMessage(signer, label) {
  return bundleOverBytes(signer, assembleSignedMessage(HASH_HEX, label));
}

// ─── the vectors ───
// decoy: "decoy:\n" + base64(a DIFFERENT hash) + "\n" + base64(HASH). The embedded
// '\n' + 44-char decoy tempts a delimiter-search parser onto the wrong hash; the fixed
// trailing window binds to HASH regardless. The decoy base64 is a fixed foreign value.
const DECOY_B64 = "AN6tvu/K/vANESIzRFVmd4iZABEiM0RVZneImQCqu8w=";
const decoyMsg = `decoy:\n${DECOY_B64}\n${B64_HASH}`;

const vectors = {
  // sig1 / EXPECTED_FELTS: no label, msg_len 44.
  sig1: await bundleOverMessage(pk1, undefined),
  // sig1_labeled / EXPECTED_FELTS_LABELED: readable label + '\n' + base64, msg_len 85.
  sig1_labeled: await bundleOverMessage(pk1, LOCKED_LABEL),
  // sig1_maxlabel: a MAX_LABEL_BYTES label -> msg_len == MAX_MSG_LEN, the largest
  // accepted message (3 SHA-512 blocks). Derived from the contract constants so the
  // boundary tracks signer.ts rather than a bare literal.
  sig1_maxlabel: await bundleOverMessage(pk1, "x".repeat(MAX_LABEL_BYTES)),
  // A real PK1 signature over the decoy-label message (msg_len 96).
  decoy_label_signature: await bundleOverBytes(pk1, decoyMsg),
  // sig2: a real PK2 signature over base64(HASH). Binds to HASH, so an account holding
  // PK1 rejects it at Ed25519 verification (INVALID_SIG), not at message binding.
  sig2: await bundleOverMessage(pk2, undefined),
  // A message one byte under the base64 hash window (B64_HASH.length): rejected
  // MSG_TOO_SHORT before decode.
  msg_too_short_signature: await bundleOverBytes(pk1, "x".repeat(B64_HASH.length - 1)),
  // A message one byte over MAX_MSG_LEN (a MAX_LABEL_BYTES + 1 label + '\n' + the 44-byte
  // base64 hash): rejected MSG_TOO_LONG before decode. Genuinely oversize so the DoS bound
  // is exercised. Derived from the contract constants, not bare literals.
  msg_too_long_signature: await bundleOverBytes(
    pk1,
    `${"x".repeat(MAX_LABEL_BYTES + 1)}\n${B64_HASH}`,
  ),
  // A hex-encoded ("0x"+64 hex chars, 66 bytes) hash message: survives the length range
  // but msg_len > 44 forces the separator check, and the byte before the trailing window
  // is a hex char, not '\n' -> BAD_MSG_SEPARATOR. Proves only base64 binds.
  hex_message_signature: await bundleOverBytes(
    pk1,
    "0x" + LOCKED_HASH.toString(16).padStart(64, "0"),
  ),
};

// Guard the boundary vectors against silent drift: their whole purpose is to pin the
// contract's length limits, so assert each still sits exactly on the boundary derived from
// the exported constants. A future MAX_MSG_LEN change these no longer track fails here
// instead of quietly degrading (e.g. sig1_maxlabel becoming an ordinary short message).
const boundaries = [
  ["sig1_maxlabel", vectors.sig1_maxlabel.msgLen, MAX_MSG_LEN],
  ["msg_too_long_signature", vectors.msg_too_long_signature.msgLen, MAX_MSG_LEN + 1],
  ["msg_too_short_signature", vectors.msg_too_short_signature.msgLen, B64_HASH.length - 1],
];
for (const [name, actual, expected] of boundaries) {
  if (actual !== expected) {
    throw new Error(
      `${name}: msg_len ${actual} != expected boundary ${expected} - vector drifted from the contract constants`,
    );
  }
}

// ─── emit ───
const cairoLine = (name, felts) => `fn ${name}() -> Array<felt252> { array![${felts.join(", ")}] }`;
const tsArray = (felts) => felts.map((f) => `"${f}"`).join(", ") + ",";

const out = [];
out.push("=== packages/contracts/src/test_sol_account.cairo ===\n");
for (const [name, { felts, msgLen }] of Object.entries(vectors)) {
  out.push(`// ${name}: ${felts.length} felts, msg_len ${msgLen} (0x${msgLen.toString(16)})`);
  out.push(cairoLine(name, felts) + "\n");
}
out.push("=== packages/core/src/garaga.test.ts ===\n");
out.push("EXPECTED_FELTS:");
out.push(tsArray(vectors.sig1.felts) + "\n");
out.push("EXPECTED_FELTS_LABELED:");
out.push(tsArray(vectors.sig1_labeled.felts) + "\n");

const pk2limbs = pubkeyToU256Limbs(pk2.pubkey);
out.push(`PK2 limbs: low=0x${pk2limbs.low.toString(16)} high=0x${pk2limbs.high.toString(16)}`);

console.log(out.join("\n") + "\n");
