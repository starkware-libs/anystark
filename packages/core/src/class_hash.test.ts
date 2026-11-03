import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hash, num } from "starknet";
import { CHAIN_IDS } from "./config";
import { SOL_ACCOUNT_CLASS_HASHES } from "./key_to_address";

// Compiled-class-hash lock (fund-safety gate)
// The committed ./__fixtures__/sol_account.contract_class.json is a byte copy of
// the artifact built from the contract source at HEAD. So the pinned sepolia class
// hash MUST equal the class hash recomputed from that fixture. The same literal is
// also locked as a frozen value (see the "sepolia deploy hash (frozen literal
// lock)" test in key_to_address.test.ts): counterfactual addresses derive from it,
// so it must never change once accounts exist. A drift here means @starkware-libs/anystark-core pins a
// class hash that is not the class the source builds.
//
// The build output under packages/contracts/target/ is git-ignored, so this test
// loads the committed copy of the compiled contract class from
// ./__fixtures__/sol_account.contract_class.json. Refreshing that fixture is a
// MANUAL, pre-launch-only procedure: the single frozen deploy hash never routinely
// changes, and once accounts exist it must not move at all. With the pinned
// toolchain (scarb 2.18.0, garaga =1.1.0, per packages/contracts/README.md):
//   1. rebuild the contract:  cd packages/contracts && scarb build
//   2. copy the built target/dev/sol_account_SolAccount.contract_class.json over
//      packages/core/src/__fixtures__/sol_account.contract_class.json
//   3. update the pinned class-hash constant (SOL_ACCOUNT_CLASS_HASHES) in
//      key_to_address.ts to the new hash.
// Then regenerate the locked derivation vector (gen_derivation_vector.mjs) as its
// output instructs.
const CONTRACT_CLASS_PATH = fileURLToPath(
  new URL("./__fixtures__/sol_account.contract_class.json", import.meta.url),
);

describe("sol_account compiled class hash (locked)", () => {
  it("matches the pinned sepolia class hash", () => {
    const contractClass = JSON.parse(readFileSync(CONTRACT_CLASS_PATH, "utf8"));
    const computedClassHash = hash.computeContractClassHash(contractClass);
    // Normalize both sides with num.toHex so any leading-zero-nibble difference between
    // the computed hash and the pinned literal does not cause a spurious mismatch.
    expect(num.toHex(computedClassHash)).toBe(
      num.toHex(SOL_ACCOUNT_CLASS_HASHES[CHAIN_IDS.sepolia]),
    );
  });
});
