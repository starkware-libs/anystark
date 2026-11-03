import { describe, it, expect } from "vitest";
import {
  assertUniqueAllowedCallTargets,
  checkBuildTransaction,
  checkExecuteTransaction,
  ConflictingAccountAddressError,
  extractTargets,
  normalizeFelt,
  InvalidFeltError,
  InvalidOutsideExecutionError,
  type SponsorshipPolicy,
} from "../src/policy.js";

const TARGET = "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7";
const SELECTOR = "0x0083afd3f4caedc6eebf44246fe54e38c95e3179a5ec9ea81740eca5b482d12e";
const CLASS_HASH = "0x061dac032f228abef9c6626f995015233097ae253a7f72d68552db02f2971b8f";

const policy: SponsorshipPolicy = {
  allowedCalls: [{ to: TARGET, selectors: [SELECTOR] }],
  sponsoredClassHashes: [CLASS_HASH],
};

function invokeTx(calls: { to: string; selector: string; calldata?: string[] }[]) {
  return { transaction: { type: "invoke", invoke: { user_address: "0x1234", calls } } };
}

describe("checkBuildTransaction", () => {
  it("allows an allowlisted invoke", () => {
    const d = checkBuildTransaction(invokeTx([{ to: TARGET, selector: SELECTOR }]), policy);
    expect(d.ok).toBe(true);
    expect(d.rateLimitKey).toBe(normalizeFelt("0x1234"));
  });

  it("rejects a non-allowlisted target", () => {
    const d = checkBuildTransaction(invokeTx([{ to: "0xdead", selector: SELECTOR }]), policy);
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/not allowlisted/);
  });

  it("rejects a disallowed selector on an allowlisted target", () => {
    const d = checkBuildTransaction(invokeTx([{ to: TARGET, selector: "0xbeef" }]), policy);
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/selector/);
  });

  it("rejects a deploy with an unsponsored class hash", () => {
    const d = checkBuildTransaction(
      { transaction: { type: "deploy", deployment: { address: "0xabc", class_hash: "0xbad" } } },
      policy,
    );
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/class hash/);
  });

  it("allows deploy_and_invoke happy path", () => {
    const d = checkBuildTransaction(
      {
        transaction: {
          type: "deploy_and_invoke",
          deployment: { address: "0xabc", class_hash: CLASS_HASH },
          invoke: { user_address: "0xabc", calls: [{ to: TARGET, selector: SELECTOR }] },
        },
      },
      policy,
    );
    expect(d.ok).toBe(true);
    expect(d.rateLimitKey).toBe(normalizeFelt("0xabc"));
  });

  it("rejects deploy_and_invoke when the class hash is unsponsored", () => {
    const d = checkBuildTransaction(
      {
        transaction: {
          type: "deploy_and_invoke",
          deployment: { address: "0xabc", class_hash: "0xbad" },
          invoke: { user_address: "0xabc", calls: [{ to: TARGET, selector: SELECTOR }] },
        },
      },
      policy,
    );
    expect(d.ok).toBe(false);
  });

  it("rejects an unknown transaction type", () => {
    const d = checkBuildTransaction({ transaction: { type: "teleport" } }, policy);
    expect(d.ok).toBe(false);
  });
});

// SNIP-9/SNIP-12 OutsideExecution V2 typed-data shape used by executeTransaction:
// calls live at transaction.invoke.typed_data.message.Calls with capitalized
// `To`/`Selector` fields (differs from the lowercase build shape).
function executeTx(
  calls: { To: string; Selector: string; Calldata?: string[] }[],
  user_address = "0x1234",
) {
  return {
    transaction: {
      type: "invoke",
      invoke: {
        user_address,
        typed_data: { domain: { version: "2", revision: "1" }, message: { Calls: calls } },
      },
    },
  };
}

describe("checkExecuteTransaction", () => {
  it("allows an allowlisted execute (capitalized typed-data calls)", () => {
    const d = checkExecuteTransaction(executeTx([{ To: TARGET, Selector: SELECTOR }]), policy);
    expect(d.ok).toBe(true);
    expect(d.rateLimitKey).toBe(normalizeFelt("0x1234"));
  });

  it("rejects a non-allowlisted target inside the signed typed data", () => {
    const d = checkExecuteTransaction(executeTx([{ To: "0xdead", Selector: SELECTOR }]), policy);
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/not allowlisted/);
  });

  it("rejects a disallowed selector inside the signed typed data", () => {
    const d = checkExecuteTransaction(executeTx([{ To: TARGET, Selector: "0xbeef" }]), policy);
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/selector/);
  });

  it("extractTargets reads calls from both build and execute shapes", () => {
    const fromBuild = extractTargets(invokeTx([{ to: TARGET, selector: SELECTOR }]), "build");
    const fromExecute = extractTargets(executeTx([{ To: TARGET, Selector: SELECTOR }]), "execute");
    expect(fromBuild?.calls).toEqual([{ to: TARGET, selector: SELECTOR }]);
    expect(fromExecute?.calls).toEqual([{ to: TARGET, selector: SELECTOR }]);
  });
});

describe("extractTargets call-source precedence (confused-deputy guard)", () => {
  // An execute request whose SIGNED typed_data carries the (malicious) calls the
  // upstream will actually run, while a benign allowlisted invoke.calls is also
  // attached. The execute path must validate ONLY the signed calls, never the
  // client-supplied invoke.calls — otherwise the malicious calls get sponsored.
  function spoofedExecuteTx(type = "invoke") {
    return {
      transaction: {
        type,
        ...(type === "deploy_and_invoke"
          ? { deployment: { address: "0x1234", class_hash: CLASS_HASH } }
          : {}),
        invoke: {
          user_address: "0x1234",
          // benign, allowlisted — attacker bait
          calls: [{ to: TARGET, selector: SELECTOR }],
          // the actually-signed (and actually-executed) malicious call
          typed_data: {
            domain: { version: "2", revision: "1" },
            message: { Calls: [{ To: "0xdead", Selector: SELECTOR }] },
          },
        },
      },
    };
  }

  it("execute reads calls ONLY from the signed typed_data, ignoring invoke.calls", () => {
    const targets = extractTargets(spoofedExecuteTx(), "execute");
    expect(targets?.calls).toEqual([{ to: "0xdead", selector: SELECTOR }]);
  });

  it.each(["invoke", "deploy_and_invoke"])(
    "checkExecuteTransaction rejects the %s spoof (validates the signed calls)",
    (type) => {
      const d = checkExecuteTransaction(spoofedExecuteTx(type), policy);
      expect(d.ok).toBe(false);
      expect(d.reason).toMatch(/not allowlisted/);
    },
  );

  it("build reads calls ONLY from invoke.calls, ignoring any typed_data", () => {
    const targets = extractTargets(spoofedExecuteTx(), "build");
    expect(targets?.calls).toEqual([{ to: TARGET, selector: SELECTOR }]);
  });
});

describe("policy branch coverage", () => {
  it("allows any selector on a target when selectors is omitted (allow-any)", () => {
    const anySelector: SponsorshipPolicy = {
      allowedCalls: [{ to: TARGET }],
      sponsoredClassHashes: [],
    };
    const d = checkBuildTransaction(invokeTx([{ to: TARGET, selector: "0xbeef" }]), anySelector);
    expect(d.ok).toBe(true);
  });

  it("allows a plain deploy with a sponsored class hash (happy path)", () => {
    const d = checkBuildTransaction(
      { transaction: { type: "deploy", deployment: { address: "0xabc", class_hash: CLASS_HASH } } },
      policy,
    );
    expect(d.ok).toBe(true);
    expect(d.rateLimitKey).toBe(normalizeFelt("0xabc"));
  });

  it("rejects an invoke with no calls", () => {
    const d = checkBuildTransaction(invokeTx([]), policy);
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/no calls/);
  });
});

describe("normalizeFelt", () => {
  it("canonicalizes leading zeros (0x04 == 0x4)", () => {
    expect(normalizeFelt("0x04")).toBe(normalizeFelt("0x4"));
    expect(normalizeFelt("0x04")).toBe("0x4");
  });

  it("lowercases hex", () => {
    expect(normalizeFelt("0xABCD")).toBe("0xabcd");
  });

  it("throws InvalidFeltError on malformed input instead of a raw BigInt throw", () => {
    expect(() => normalizeFelt("0xZZ")).toThrow(InvalidFeltError);
    expect(() => normalizeFelt("")).toThrow(InvalidFeltError);
    expect(() => normalizeFelt("not-a-felt")).toThrow(InvalidFeltError);
  });

  it("rejects values at or above the field prime (not a valid felt)", () => {
    // P = 2^251 + 17·2^192 + 1
    const P = 2n ** 251n + 17n * 2n ** 192n + 1n;
    expect(() => normalizeFelt("0x" + P.toString(16))).toThrow(InvalidFeltError);
    expect(() => normalizeFelt("0x" + (P + 1n).toString(16))).toThrow(InvalidFeltError);
    // P - 1 is the largest valid felt.
    expect(normalizeFelt("0x" + (P - 1n).toString(16))).toBe("0x" + (P - 1n).toString(16));
  });

  it("matches selectors across zero-padding via the policy", () => {
    const padded: SponsorshipPolicy = {
      allowedCalls: [{ to: "0x004", selectors: ["0x0083"] }],
      sponsoredClassHashes: [],
    };
    const d = checkBuildTransaction(invokeTx([{ to: "0x4", selector: "0x83" }]), padded);
    expect(d.ok).toBe(true);
  });
});

describe("assertUniqueAllowedCallTargets", () => {
  // Same address, differ only in the LAST nibble — a genuine pair of distinct
  // targets that must NOT be flagged as duplicates.
  const TARGET_A = "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7";
  const TARGET_B = "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc6";
  const TRANSFER = "0x0083afd3f4caedc6eebf44246fe54e38c95e3179a5ec9ea81740eca5b482d12e";
  const APPROVE = "0x0219209e083275171774dab1df80982e9df2096516f06319c5c6d71ae0a8480c";

  // Capture the thrown message so each case can assert on the meaningful parts
  // (both positional indices, both ORIGINAL spellings, the merge instruction).
  function duplicateErrorMessage(policy: SponsorshipPolicy): string {
    try {
      assertUniqueAllowedCallTargets(policy);
    } catch (e) {
      return (e as Error).message;
    }
    throw new Error("expected assertUniqueAllowedCallTargets to throw, but it did not");
  }

  it("rejects two entries with identical `to` spellings, naming both indices and the merge fix", () => {
    const policy: SponsorshipPolicy = {
      allowedCalls: [
        { to: TARGET_A, selectors: [TRANSFER] },
        { to: TARGET_A, selectors: [APPROVE] },
      ],
      sponsoredClassHashes: [],
    };
    const message = duplicateErrorMessage(policy);
    expect(message).toContain("allowedCalls[1].to");
    expect(message).toContain("allowedCalls[0].to");
    expect(message).toContain(`("${TARGET_A}")`);
    expect(message).toContain("merge the selector lists into a single entry");
  });

  it("rejects differently-padded spellings of the same address, preserving each original spelling", () => {
    const policy: SponsorshipPolicy = {
      allowedCalls: [
        { to: "0x04", selectors: [TRANSFER] },
        { to: "0x4", selectors: [APPROVE] },
      ],
      sponsoredClassHashes: [],
    };
    const message = duplicateErrorMessage(policy);
    // Duplicate is index 1 ("0x4"); it collides with the first occurrence index 0 ("0x04").
    expect(message).toContain(`allowedCalls[1].to ("0x4")`);
    expect(message).toContain(`allowedCalls[0].to ("0x04")`);
    expect(message).toContain("merge the selector lists into a single entry");
  });

  it("rejects uppercase-hex vs lowercase spellings of the same address (BigInt lowercasing)", () => {
    const policy: SponsorshipPolicy = {
      allowedCalls: [{ to: "0xAbC", selectors: [TRANSFER] }, { to: "0xabc" }],
      sponsoredClassHashes: [],
    };
    const message = duplicateErrorMessage(policy);
    expect(message).toContain(`allowedCalls[1].to ("0xabc")`);
    expect(message).toContain(`allowedCalls[0].to ("0xAbC")`);
    expect(message).toContain("merge the selector lists into a single entry");
  });

  it("rejects a bare entry duplicating a selector-list entry (broadening guard)", () => {
    const policy: SponsorshipPolicy = {
      allowedCalls: [{ to: TARGET_A, selectors: [TRANSFER] }, { to: TARGET_A }],
      sponsoredClassHashes: [],
    };
    const message = duplicateErrorMessage(policy);
    expect(message).toContain("allowedCalls[1].to");
    expect(message).toContain("allowedCalls[0].to");
  });

  it("names both colliding entries when three entries include one duplicate pair", () => {
    const policy: SponsorshipPolicy = {
      allowedCalls: [
        { to: TARGET_A, selectors: [TRANSFER] },
        { to: TARGET_B, selectors: [TRANSFER] },
        { to: TARGET_A, selectors: [APPROVE] },
      ],
      sponsoredClassHashes: [],
    };
    const message = duplicateErrorMessage(policy);
    // The duplicate is index 2; it collides with the first occurrence at index 0.
    expect(message).toContain("allowedCalls[2].to");
    expect(message).toContain("allowedCalls[0].to");
    expect(message).toContain(`("${TARGET_A}")`);
  });

  it("accepts two DIFFERENT addresses that differ only in the last nibble", () => {
    const policy: SponsorshipPolicy = {
      allowedCalls: [
        { to: TARGET_A, selectors: [TRANSFER] },
        { to: TARGET_B, selectors: [APPROVE] },
      ],
      sponsoredClassHashes: [],
    };
    expect(() => assertUniqueAllowedCallTargets(policy)).not.toThrow();
  });

  it("does NOT throw on an empty allowedCalls list (no-op contract)", () => {
    const policy: SponsorshipPolicy = { allowedCalls: [], sponsoredClassHashes: [] };
    expect(() => assertUniqueAllowedCallTargets(policy)).not.toThrow();
  });
});

const V2_DOMAIN = { version: "2", revision: "1" };
const V1_DOMAIN = { version: "1" };

function signedExecuteTx(domain: unknown, message: Record<string, unknown>) {
  return {
    transaction: {
      type: "invoke",
      invoke: { user_address: "0x1234", typed_data: { domain, message } },
    },
  };
}

describe("execute reads only the signed form's fields", () => {
  it("validates the signed V2 To, ignoring an unsigned lowercase `to`", () => {
    const d = checkExecuteTransaction(
      signedExecuteTx(V2_DOMAIN, {
        Calls: [{ To: "0xdead", Selector: SELECTOR, to: TARGET, selector: SELECTOR }],
      }),
      policy,
    );
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/not allowlisted/);
  });

  it("validates the signed V2 Selector, ignoring an unsigned lowercase `selector`", () => {
    const d = checkExecuteTransaction(
      signedExecuteTx(V2_DOMAIN, {
        Calls: [{ To: TARGET, Selector: "0xbeef", to: TARGET, selector: SELECTOR }],
      }),
      policy,
    );
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/selector/);
  });

  it("accepts a V2 domain with numeric version and revision", () => {
    const d = checkExecuteTransaction(
      signedExecuteTx({ version: 2, revision: 1 }, { Calls: [{ To: TARGET, Selector: SELECTOR }] }),
      policy,
    );
    expect(d.ok).toBe(true);
  });

  it("allows an allowlisted V1 execute", () => {
    const d = checkExecuteTransaction(
      signedExecuteTx(V1_DOMAIN, { calls: [{ to: TARGET, selector: SELECTOR }] }),
      policy,
    );
    expect(d.ok).toBe(true);
  });

  it("validates the signed V1 `to`, ignoring an unsigned capitalized To", () => {
    const d = checkExecuteTransaction(
      signedExecuteTx(V1_DOMAIN, {
        calls: [{ to: "0xdead", selector: SELECTOR, To: TARGET, Selector: SELECTOR }],
      }),
      policy,
    );
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/not allowlisted/);
  });

  it.each([
    { label: "V2 call with only lowercase fields", domain: V2_DOMAIN, key: "Calls", casing: "to" },
    {
      label: "V1 call with only capitalized fields",
      domain: V1_DOMAIN,
      key: "calls",
      casing: "To",
    },
  ])("denies a $label", ({ domain, key, casing }) => {
    const call =
      casing === "To" ? { To: TARGET, Selector: SELECTOR } : { to: TARGET, selector: SELECTOR };
    const d = checkExecuteTransaction(signedExecuteTx(domain, { [key]: [call] }), policy);
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/missing to\/selector/);
  });

  it.each([
    { label: "V1 domain with an added V2 `Calls`", domain: V1_DOMAIN },
    { label: "V2 domain with an added V1 `calls`", domain: V2_DOMAIN },
  ])("rejects a $label", ({ domain }) => {
    const tx = signedExecuteTx(domain, {
      calls: [{ to: "0xdead", selector: SELECTOR }],
      Calls: [{ To: TARGET, Selector: SELECTOR }],
    });
    expect(() => checkExecuteTransaction(tx, policy)).toThrow(InvalidOutsideExecutionError);
  });

  const UNRECOGNIZED_DOMAIN = /unrecognized OutsideExecution typed-data domain/;

  it.each([
    {
      label: "a V2 domain with only `calls`",
      domain: V2_DOMAIN,
      key: "calls",
      error: /no `Calls`/,
    },
    {
      label: "a V1 domain with only `Calls`",
      domain: V1_DOMAIN,
      key: "Calls",
      error: /no `calls`/,
    },
    { label: "no domain", domain: undefined, key: "Calls", error: UNRECOGNIZED_DOMAIN },
    { label: "an empty domain", domain: {}, key: "Calls", error: UNRECOGNIZED_DOMAIN },
    {
      label: "an unknown version",
      domain: { version: "9" },
      key: "Calls",
      error: UNRECOGNIZED_DOMAIN,
    },
    {
      label: "version 2 without revision",
      domain: { version: "2" },
      key: "Calls",
      error: UNRECOGNIZED_DOMAIN,
    },
    {
      label: "version 1 with a revision",
      domain: { version: "1", revision: "1" },
      key: "calls",
      error: UNRECOGNIZED_DOMAIN,
    },
    {
      label: "version 1 with a null revision",
      domain: { version: "1", revision: null },
      key: "calls",
      error: UNRECOGNIZED_DOMAIN,
    },
    {
      label: "an array revision",
      domain: { version: "2", revision: ["1"] },
      key: "Calls",
      error: UNRECOGNIZED_DOMAIN,
    },
  ])("rejects $label", ({ domain, key, error }) => {
    const call =
      key === "Calls" ? { To: TARGET, Selector: SELECTOR } : { to: TARGET, selector: SELECTOR };
    const run = () => checkExecuteTransaction(signedExecuteTx(domain, { [key]: [call] }), policy);
    expect(run).toThrow(InvalidOutsideExecutionError);
    expect(run).toThrow(error);
  });

  it.each([null, {}, "0x1"])("rejects a V2 `Calls` of %j", (calls) => {
    const run = () => checkExecuteTransaction(signedExecuteTx(V2_DOMAIN, { Calls: calls }), policy);
    expect(run).toThrow(InvalidOutsideExecutionError);
    expect(run).toThrow(/no `Calls` array/);
  });

  it("build reads only lowercase fields", () => {
    const buildTx = (call: Record<string, string>) => ({
      transaction: { type: "invoke", invoke: { user_address: "0x1234", calls: [call] } },
    });
    const shadowed = buildTx({ to: TARGET, selector: SELECTOR, To: "0xdead", Selector: "0xbeef" });
    expect(checkBuildTransaction(shadowed, policy).ok).toBe(true);

    const capitalizedOnly = buildTx({ To: TARGET, Selector: SELECTOR });
    expect(checkBuildTransaction(capitalizedOnly, policy).reason).toMatch(/missing to\/selector/);
  });

  it.each([{}, "abc", 5])("rejects a build invoke.calls of %j", (calls) => {
    const tx = { transaction: { type: "invoke", invoke: { user_address: "0x1234", calls } } };
    expect(() => checkBuildTransaction(tx, policy)).toThrow(TypeError);
  });

  it("allows a signed deploy_and_invoke execute", () => {
    const tx = {
      transaction: {
        type: "deploy_and_invoke",
        deployment: { address: "0x1234", class_hash: CLASS_HASH },
        invoke: {
          user_address: "0x1234",
          typed_data: {
            domain: V2_DOMAIN,
            message: { Calls: [{ To: TARGET, Selector: SELECTOR }] },
          },
        },
      },
    };
    const d = checkExecuteTransaction(tx, policy);
    expect(d.ok).toBe(true);
    expect(d.rateLimitKey).toBe("0x1234");
  });

  it("denies an unsupported type without reading its typed data", () => {
    const tx = { transaction: { type: "apply_action", invoke: { typed_data: {} } } };
    const d = checkExecuteTransaction(tx, policy);
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/unsupported transaction type apply_action/);
  });
});

describe("account address", () => {
  function deployAndInvokeTx(userAddress: string | undefined, deploymentAddress: string) {
    return {
      transaction: {
        type: "deploy_and_invoke",
        deployment: { address: deploymentAddress, class_hash: CLASS_HASH },
        invoke: { user_address: userAddress, calls: [{ to: TARGET, selector: SELECTOR }] },
      },
    };
  }

  it("keys the rate limit on the account when both fields agree", () => {
    const d = checkBuildTransaction(deployAndInvokeTx("0x0abc", "0xabc"), policy);
    expect(d.ok).toBe(true);
    expect(d.rateLimitKey).toBe("0xabc");
  });

  it("keys the rate limit on deployment.address when user_address is absent", () => {
    const d = checkBuildTransaction(deployAndInvokeTx(undefined, "0xabc"), policy);
    expect(d.rateLimitKey).toBe("0xabc");
  });

  it("rejects a deploy_and_invoke user_address that differs from deployment.address", () => {
    expect(() => checkBuildTransaction(deployAndInvokeTx("0x999", "0xabc"), policy)).toThrow(
      ConflictingAccountAddressError,
    );
  });

  it("keys an invoke on user_address and ignores a stray deployment.address", () => {
    const tx = {
      transaction: {
        type: "invoke",
        deployment: { address: "0xabc" },
        invoke: { user_address: "0x999", calls: [{ to: TARGET, selector: SELECTOR }] },
      },
    };
    const d = checkBuildTransaction(tx, policy);
    expect(d.ok).toBe(true);
    expect(d.rateLimitKey).toBe("0x999");
  });

  it("keys a deploy on deployment.address", () => {
    const tx = {
      transaction: {
        type: "deploy",
        deployment: { address: "0xabc", class_hash: CLASS_HASH },
        invoke: { user_address: "0x999" },
      },
    };
    expect(checkBuildTransaction(tx, policy).rateLimitKey).toBe("0xabc");
  });

  it("leaves an invoke without user_address unkeyed", () => {
    const tx = {
      transaction: {
        type: "invoke",
        deployment: { address: "0xabc" },
        invoke: { calls: [{ to: TARGET, selector: SELECTOR }] },
      },
    };
    const d = checkBuildTransaction(tx, policy);
    expect(d.ok).toBe(true);
    expect(d.rateLimitKey).toBeUndefined();
  });

  it("leaves a deploy without deployment.address unkeyed", () => {
    const tx = {
      transaction: {
        type: "deploy",
        deployment: { class_hash: CLASS_HASH },
        invoke: { user_address: "0x999" },
      },
    };
    const d = checkBuildTransaction(tx, policy);
    expect(d.ok).toBe(true);
    expect(d.rateLimitKey).toBeUndefined();
  });
});
