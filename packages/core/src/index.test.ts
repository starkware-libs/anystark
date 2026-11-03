import { describe, expect, it } from "vitest";
import * as core from "./index";

// Export-surface lock. Object.keys only sees runtime (value) exports — type-only
// exports (ChainId, SolanaSigner, PhantomConnection, …) erase at compile time and
// never appear here. This asserts the exact set of value exports so an accidental
// removal or rename of a public API is caught as a failing test, not shipped.
const EXPECTED_VALUE_EXPORTS = [
  "CHAIN_IDS",
  "LabeledExecutor",
  "MAX_LABEL_BYTES",
  "MAX_MSG_LEN",
  "PhantomProviderWrapper",
  "SolanaAsStarknetAccount",
  "SolanaAsStarknetSigner",
  "assembleSignedMessage",
  "buildEddsaSignatureFelts",
  "deriveSolAccountAddress",
  "feltToBase64Hash",
  "getPhantomProvider",
  "pubkeyToU256Limbs",
  "resolveDeployClassHash",
];

describe("@starkware-libs/anystark-core entry", () => {
  it("imports without throwing", () => {
    expect(typeof core).toBe("object");
  });

  it("exposes exactly the expected public value exports", () => {
    expect(Object.keys(core).sort()).toEqual(EXPECTED_VALUE_EXPORTS);
  });
});
