#!/usr/bin/env node
// sol_account counterfactual-derivation EXPECTED-block fix script
//
// Recomputes the locked derivation vector (low / high / salt / address) behind the
// `EXPECTED` block in packages/core/src/key_to_address.test.ts, from the fixed test
// pubkey (bytes 0..31 as a little-endian u256) against the frozen sol_account class
// hash. There is a single pinned hash per chain (no `latest`/`deploy` split), and a
// new contract version does not move an existing chain's derived address.
// Regenerate EXPECTED (run this, then paste the emitted block over `EXPECTED`) only
// when establishing a new chain's pinned hash, or if the test pubkey changes.
//
//   npm run -w @starkware-libs/anystark-core build
//   node packages/core/scripts/gen_derivation_vector.mjs
//   node packages/core/scripts/gen_derivation_vector.mjs classHash=0x<hash>
//
// CONVENIENCE, NOT AN INDEPENDENT ORACLE: this script derives the values with the
// very same starknet.js path (@starkware-libs/anystark-core's deriveSolAccountAddress) that
// key_to_address.test.ts asserts against, so it cannot by itself prove the TS
// derivation matches Cairo/network. The independent bindings live elsewhere:
//   - the Cairo salt cross-check (derived_salt_matches_ts_locked_vector) and the
//     deployed-address fixture (print_derived_deploy_vector ->
//     __fixtures__/cairo_derivation_vector.json) in packages/contracts, and
//   - the compiled-class-hash lock in class_hash.test.ts, and
//   - the live sepolia e2e (npm run test:e2e:sepolia).
// This script only removes the by-hand arithmetic when the hash deliberately moves.

/* global process, console */
import { num } from "starknet";
import { CHAIN_IDS, resolveDeployClassHash, deriveSolAccountAddress } from "../dist/index.js";

// Address derivation uses the pinned (frozen) class hash (SOL_ACCOUNT_CLASS_HASHES
// is not part of the package surface, so resolve it through the public helper).
// The `classHash=` override exists only to establish a NEW chain's pinned hash.
// Passing any other hash here would repin EXPECTED to a different address and break
// the fund-safety anchor, so never do that for an existing chain.
const DEFAULTS = {
  classHash: resolveDeployClassHash({ chainId: CHAIN_IDS.sepolia }),
};
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const separatorIndex = arg.indexOf("=");
    if (separatorIndex < 0) throw new Error(`bad arg (want key=value): ${arg}`);
    return [arg.slice(0, separatorIndex), arg.slice(separatorIndex + 1)];
  }),
);
for (const key of Object.keys(args)) {
  if (!(key in DEFAULTS)) throw new Error(`unknown param: ${key}`);
}
const params = { ...DEFAULTS, ...args };

// The locked test pubkey: 32 bytes 0,1,..,31, read as a little-endian u256. Kept
// byte-identical to PUBKEY in key_to_address.test.ts.
const PUBKEY = Uint8Array.from({ length: 32 }, (_, i) => i);
const derivation = deriveSolAccountAddress(PUBKEY, params.classHash);

const toHexLiteral = (v) => "0x" + BigInt(v).toString(16);
const block =
  "const EXPECTED = {\n" +
  `  low: ${toHexLiteral(derivation.low)}n,\n` +
  `  high: ${toHexLiteral(derivation.high)}n,\n` +
  `  salt: "${num.toHex(derivation.salt)}",\n` +
  `  address: "${num.toHex(derivation.address)}",\n` +
  "};";

console.log(`classHash      ${params.classHash}`);
console.log(`pubkey         bytes 0..31 (little-endian u256)`);
console.log(
  `limbs          low=${toHexLiteral(derivation.low)} high=${toHexLiteral(derivation.high)}`,
);
console.log(`salt           ${num.toHex(derivation.salt)}`);
console.log(`address        ${num.toHex(derivation.address)}`);
console.log("");
console.log("paste over EXPECTED in packages/core/src/key_to_address.test.ts:");
console.log("");
console.log(block);
