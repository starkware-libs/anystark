#!/usr/bin/env node
// ─── SNIP-9 v2 `execute_from_outside_v2` locked-vector generator ───
//
// Produces the signature felt bundle behind the locked vector in
// packages/contracts/src/test_outside_execution.cairo — the snforge happy-path
// tests of OZ's SRC9Component wired to SolAccount (Ed25519 pubkey = the repo's
// LOCKED_PUBKEY, seed bytes 0..31):
//   1. SNIP-12 rev-1 typed-data hash of the OutsideExecution struct, computed with
//      starknet.js's own `outsideExecution.getTypedData` helper (domain
//      name='Account.execute_from_outside', version=2, revision=1, chainId param),
//      bound to the pinned account address.
//   2. Ed25519 signature (node:crypto, PKCS8-wrapped raw seed) over the base64
//      message form SolAccount verifies: the 44-char standard base64 of the hash's
//      32 big-endian bytes (no label), assembled with @starkware-libs/anystark-core's assembleSignedMessage.
//   3. The full garaga EdDSASignatureWithHint felt bundle via the repo's REAL
//      encoder, @starkware-libs/anystark-core's buildEddsaSignatureFelts (dogfoods the SDK path).
//
// Reproduce the committed vector (all-default params) from the repo root:
//   npm run -w @starkware-libs/anystark-core build
//   node packages/core/scripts/gen_snip9_vector.mjs
// then diff the emitted vector.json `felts` against the Cairo fixture.
//
// Deterministic and re-runnable. Params via argv as key=value:
//   chainId=0x534e5f5345504f4c4941  (snforge 0.60.0 default: 'SN_SEPOLIA')
//   accountAddress=0x1234           (pinned via snforge deploy_at)
//   caller=<felt>                   (empty => ANY_CALLER; a felt pins who may submit)
//   target=0x5678 entrypoint=transfer calldata=0xcafe (comma-separated)
//   nonce=0x1 executeAfter=0 executeBefore=3600
//   expectedHash=<dec-or-hex>  (Cairo-side hash to cross-check; auto-set for defaults)
//   allowUnverified=1          (write despite no expectedHash; skips the TS<->Cairo cross-check)
//   out=<path to vector.json>
//
// Cross-check against OZ's Cairo implementation: the script HARD-FAILS on a
// TS/Cairo hash mismatch, so the vector is never TS-only. For the all-default
// tuple the anchor is baked in below — OZ's openzeppelin_account 3.0.0
// `get_message_hash` under snforge 0.60.0 produced
//   3063058270246948517193398873300323602788854223625578252710872219477627299975
// For any other tuple, the script REFUSES to write a vector unless you supply the
// Cairo-side hash as expectedHash= (re-derive it with the committed `#[ignore]`d
// `print_vector_snip12_hash` test — see test_outside_execution.cairo).

/* global process, console, Buffer */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as sn from "starknet";
import * as core from "../dist/index.js"; // run `npm run -w @starkware-libs/anystark-core build` first

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");

// ─── params ───
const DEFAULTS = {
  chainId: "0x534e5f5345504f4c4941", // 'SN_SEPOLIA' — snforge 0.60.0 get_tx_info().chain_id
  accountAddress: "0x1234",
  caller: "", // "" => ANY_CALLER sentinel; a felt address pins WHO may submit
  target: "0x5678",
  entrypoint: "transfer", // hashed with getSelectorFromName == Cairo selector!("transfer")
  calldata: "0xcafe",
  nonce: "0x1",
  executeAfter: "0",
  executeBefore: "3600",
  expectedHash: "",
  allowUnverified: "", // set to "1" to write a vector with no TS<->Cairo cross-check
  out: path.join(HERE, "vector.json"),
};
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const i = a.indexOf("=");
    if (i < 0) throw new Error(`bad arg (want key=value): ${a}`);
    return [a.slice(0, i), a.slice(i + 1)];
  }),
);
for (const k of Object.keys(args)) {
  if (!(k in DEFAULTS)) throw new Error(`unknown param: ${k}`);
}
const p = { ...DEFAULTS, ...args };
const hashParams = [
  "chainId",
  "accountAddress",
  "caller",
  "target",
  "entrypoint",
  "calldata",
  "nonce",
  "executeAfter",
  "executeBefore",
];
const allDefault = hashParams.every((k) => p[k] === DEFAULTS[k]);
// Locked Cairo-side hash for the default tuple (see the header's cross-check note).
const CAIRO_HASH_FOR_DEFAULTS =
  3063058270246948517193398873300323602788854223625578252710872219477627299975n;
const expectedHash = p.expectedHash
  ? BigInt(p.expectedHash)
  : allDefault
    ? CAIRO_HASH_FOR_DEFAULTS
    : null;

const hex64 = (v) => "0x" + BigInt(v).toString(16).padStart(64, "0");
const calldata = p.calldata === "" ? [] : p.calldata.split(",").map((x) => sn.num.toHex(x.trim()));
// execute_after / execute_before are u64 on-chain; keep them BigInt end-to-end so
// values above 2^53 hash the exact fields (Number() would silently lose precision).
const asU64 = (name, s) => {
  const v = BigInt(s);
  if (v < 0n || v >= 1n << 64n) throw new Error(`${name} out of u64 range: ${s}`);
  return v;
};
const executeAfter = asU64("executeAfter", p.executeAfter);
const executeBefore = asU64("executeBefore", p.executeBefore);

// ─── 1. SNIP-12 rev-1 hash via starknet.js's own SNIP-9 helper ───
// Account.getOutsideTransaction encodes caller 'ANY_CALLER' as this shortstring felt
// before hashing; empty caller= means the same (constants.OutsideExecutionCallerAny),
// while a felt address pins WHO may submit (folded into the SNIP-12 hash below).
const caller = p.caller === "" ? sn.constants.OutsideExecutionCallerAny : sn.num.toHex(p.caller);
const calls = [{ contractAddress: p.target, entrypoint: p.entrypoint, calldata }];
const typedDataV2 = sn.outsideExecution.getTypedData(
  p.chainId,
  { caller, execute_after: executeAfter, execute_before: executeBefore },
  p.nonce,
  calls,
  sn.OutsideExecutionVersion.V2,
);
const selector = sn.num.toHex(typedDataV2.message.Calls[0].Selector);
const snip12Hash = BigInt(sn.typedData.getMessageHash(typedDataV2, p.accountAddress));

let crossCheck;
if (expectedHash !== null) {
  if (snip12Hash !== expectedHash) {
    throw new Error(
      `TS/Cairo SNIP-12 hash MISMATCH:\n  TS    = ${snip12Hash}\n  Cairo = ${expectedHash}`,
    );
  }
  crossCheck = "MATCHED";
} else if (p.allowUnverified === "1") {
  // Escape hatch: keeps the "never TS-only by construction" property true for the
  // default path while letting an operator opt into an unverified custom vector.
  crossCheck = "UNVERIFIED (allowUnverified=1, no TS<->Cairo cross-check)";
} else {
  throw new Error(
    "refusing to write an unverified vector: non-default params with no expectedHash. " +
      "Re-derive the Cairo hash (print_vector_snip12_hash test) and pass expectedHash=, " +
      "or pass allowUnverified=1 to override.",
  );
}

// ─── 2. Ed25519 sign the Phantom text form with seed bytes 0..31 ───
const seed = Uint8Array.from({ length: 32 }, (_, i) => i);
const pkcs8 = Buffer.concat([
  Buffer.from("302e020100300506032b657004220420", "hex"), // PKCS8 DER prefix for raw Ed25519 seed
  Buffer.from(seed),
]);
const privateKey = crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
const spki = crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" });
const pubkey = new Uint8Array(spki.subarray(spki.length - 32));

// Pubkey must be the repo's LOCKED_PUBKEY (parsed from source, not re-declared here).
const tv = fs.readFileSync(path.join(REPO, "packages/core/src/test_vectors.ts"), "utf8");
const locked = Uint8Array.from(
  tv
    .match(/LOCKED_PUBKEY = Uint8Array\.from\(\[([^\]]+)\]\)/)[1]
    .split(",")
    .map((s) => Number(s.trim())),
);
if (Buffer.compare(Buffer.from(pubkey), Buffer.from(locked)) !== 0) {
  throw new Error("derived pubkey (seed 0..31) != LOCKED_PUBKEY from packages/core");
}

// The exact bytes SolAccount verifies: base64 of the hash's 32 big-endian bytes, no
// label (the shared signer path - see assembleSignedMessage). We keep the "0x"+hex64
// form only as a human-readable label in the emitted vector.json for debugging.
const messageText = hex64(snip12Hash);
const msgBytes = Buffer.from(core.assembleSignedMessage("0x" + snip12Hash.toString(16)));
const sig64 = new Uint8Array(crypto.sign(null, msgBytes, privateKey));

// ─── 3. Felt bundle via the repo's real encoder ───
const felts = await core.buildEddsaSignatureFelts(pubkey, sig64, new Uint8Array(msgBytes));
const { low: pyLo, high: pyHi } = core.pubkeyToU256Limbs(pubkey);
// The garaga v1 bundle carries no Py (the account verifies against its stored signer),
// so the serialized felts are [Ry.low, Ry.high, s.low, s.high, msg_len, msg bytes…].
if (BigInt(felts[4]) !== BigInt(msgBytes.length)) {
  throw new Error(`felts[4] != message length ${msgBytes.length}, encoder layout changed?`);
}

// ─── output ───
const vector = {
  chainId: p.chainId,
  accountAddress: p.accountAddress,
  caller,
  target: p.target,
  entrypoint: p.entrypoint,
  selector,
  calldata,
  nonce: p.nonce,
  executeAfter: executeAfter.toString(),
  executeBefore: executeBefore.toString(),
  snip12Hash: "0x" + snip12Hash.toString(16),
  snip12HashDec: snip12Hash.toString(10),
  crossCheck,
  messageText,
  pubkeyLimbs: { low: sn.num.toHex(pyLo), high: sn.num.toHex(pyHi) },
  felts,
};
fs.writeFileSync(p.out, JSON.stringify(vector, null, 2) + "\n");

console.log(`chainId        ${p.chainId}`);
const callerLabel = p.caller === "" ? " ('ANY_CALLER')" : "";
console.log(`account        ${p.accountAddress}   caller ${caller}${callerLabel}`);
console.log(
  `call           to=${p.target} selector=${selector} (${p.entrypoint}) calldata=[${calldata}]`,
);
console.log(`nonce/window   ${p.nonce} / [${p.executeAfter}, ${p.executeBefore}]`);
console.log(`snip12Hash     0x${snip12Hash.toString(16)}`);
console.log(`               (dec ${snip12Hash})`);
console.log(`TS<->Cairo     ${crossCheck}`);
console.log(`messageText    ${messageText}`);
console.log(`pubkey         LOCKED_PUBKEY match OK; limbs low=${pyLo} high=${pyHi}`);
console.log(`felts          ${felts.length} felts -> ${p.out}`);
