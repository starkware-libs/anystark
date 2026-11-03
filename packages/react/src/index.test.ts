import { describe, expect, it } from "vitest";
import * as react from "./index";

// Export-surface lock. Object.keys only sees runtime (value) exports. Type-only
// exports (PaymasterConfig, PhantomConnectorConfig, ChainId, SolAccountDerivation)
// erase at compile time and never appear here. This asserts the exact set of value
// exports so an accidental removal or rename of a public API is caught as a
// failing test, not shipped.
const EXPECTED_VALUE_EXPORTS = [
  "LabeledExecutor",
  "PhantomConnector",
  "deriveSolAccountAddress",
  "resolveDeployClassHash",
];

describe("@starkware-libs/anystark-react entry", () => {
  it("imports without throwing", () => {
    expect(typeof react).toBe("object");
  });

  it("exposes exactly the expected public value exports", () => {
    expect(Object.keys(react).sort()).toEqual(EXPECTED_VALUE_EXPORTS);
  });
});
