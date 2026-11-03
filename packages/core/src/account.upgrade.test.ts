import { afterEach, describe, expect, it, vi } from "vitest";

// starknet.js binds globalThis.fetch once, at module load, so the mock must exist
// BEFORE the starknet import below — vi.hoisted runs ahead of the hoisted ESM
// imports (mirrors account.test.ts).
const { fetchMock, realFetch } = vi.hoisted(() => {
  const realFetch = globalThis.fetch;
  const fetchMock = vi.fn<(url: unknown, init?: RequestInit) => Promise<Response>>();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return { fetchMock, realFetch };
});

import {
  OutsideExecutionVersion,
  RpcError,
  constants,
  hash,
  outsideExecution,
  type Call,
} from "starknet";
import { SolanaAsStarknetAccount } from "./account";
import { CHAIN_IDS, type PaymasterConfig } from "./config";
import { deriveSolAccountAddress, resolveDeployClassHash } from "./key_to_address";
import { LOCKED_PUBKEY, lockedEd25519Signer } from "./test_vectors";

// The single pinned class the account is DEPLOYED/derived as: it pins the account's
// counterfactual address and is what the constructor deploys against.
const DEPLOY_CLASS_HASH = resolveDeployClassHash({ chainId: CHAIN_IDS.sepolia });
// An explicit, distinct upgrade target. upgrade() takes a REQUIRED class hash (the
// SDK no longer tracks a "latest" default), so tests always pass one; distinct from
// both the account address and DEPLOY_CLASS_HASH so a to/arg swap is caught.
const TARGET_CLASS_HASH = "0x123456";
const PAYMASTER_URL = "http://paymaster.localhost";
// The account signs for real (locked Ed25519 key), so its address derives from
// LOCKED_PUBKEY (garaga needs a genuine signature to build its hint).
const ACCOUNT_ADDRESS = deriveSolAccountAddress(LOCKED_PUBKEY, DEPLOY_CLASS_HASH).address;
const UPGRADE_SELECTOR = BigInt(hash.getSelectorFromName("upgrade"));

/** Every account operation runs sponsored, so a paymaster is always configured. */
function makeAccount(paymaster: PaymasterConfig = { nodeUrl: PAYMASTER_URL }) {
  return new SolanaAsStarknetAccount({
    signer: lockedEd25519Signer(),
    rpcUrl: "http://localhost:5050",
    classHash: DEPLOY_CLASS_HASH,
    paymaster,
  });
}

/** A JSON-RPC error a mock handler returns instead of a `result`. */
class JsonRpcError {
  constructor(
    readonly code: number,
    readonly message: string,
  ) {}
}

/** Route JSON-RPC POSTs to per-method handlers; returns the ordered method log so
 *  a test can assert which wire methods a path did (and did not) touch. */
function mockRpc(handlers: Record<string, (params: unknown) => unknown>): string[] {
  const methods: string[] = [];
  fetchMock.mockImplementation(async (url, init) => {
    // Bodiless requests (garaga fetching its own WASM) fall through to real fetch.
    if (init?.body === undefined) return realFetch(url as RequestInfo, init);
    const body = JSON.parse(String(init.body)) as { id: number; method: string; params?: unknown };
    methods.push(body.method);
    const handler = handlers[body.method];
    if (!handler) throw new Error(`unmocked JSON-RPC method: ${body.method}`);
    const outcome = handler(body.params);
    const payload =
      outcome instanceof JsonRpcError
        ? { error: { code: outcome.code, message: outcome.message } }
        : { result: outcome };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...payload }));
  });
  return methods;
}

/** Starknet-node handlers for a DEPLOYED account: isDeployed()'s getClassHashAt
 *  returns a hash, and getClass resolves (the upgrade target is declared). Override
 *  any handler via `extra`. */
function deployedNodeHandlers(
  extra: Record<string, (params: unknown) => unknown> = {},
): Record<string, (params: unknown) => unknown> {
  return {
    starknet_specVersion: () => "0.9.0",
    starknet_chainId: () => CHAIN_IDS.sepolia,
    // The account's on-chain class after a normal deploy is the deploy class.
    starknet_getClassHashAt: () => DEPLOY_CLASS_HASH,
    // getClass only needs to NOT throw CLASS_HASH_NOT_FOUND; the account ignores
    // its body. parseContractClassResponse tolerates an absent abi.
    starknet_getClass: () => ({}),
    ...extra,
  };
}

const PAYMASTER_FEE = {
  gas_token_price_in_strk: "0x0",
  estimated_fee_in_strk: "0x0",
  estimated_fee_in_gas_token: "0x0",
  suggested_max_fee_in_strk: "0x0",
  suggested_max_fee_in_gas_token: "0x0",
};

/** SNIP-9 v2 typed data as an honest paymaster would build it for `calls`. */
function typedDataFor(calls: Call[]) {
  return outsideExecution.getTypedData(
    CHAIN_IDS.sepolia,
    { caller: constants.OutsideExecutionCallerAny, execute_after: 0, execute_before: 3600 },
    "0x1",
    calls,
    OutsideExecutionVersion.V2,
  );
}

/** paymaster_buildTransaction result wrapping `typed_data` for a plain invoke. */
function buildResult(typed_data: unknown) {
  return {
    type: "invoke",
    typed_data,
    parameters: { version: "0x1", fee_mode: { mode: "sponsored" } },
    fee: PAYMASTER_FEE,
  };
}

/** The wire shape of a call inside a paymaster_buildTransaction request. */
type WireCall = { to: string; selector: string; calldata: string[] };
type BuildParams = {
  transaction: { type: string; invoke: { user_address: string; calls: WireCall[] } };
};

/** Flatten every hex/decimal string in a nested params object to felts. Lets an
 *  assertion look for a selector/argument in the account calldata without pinning
 *  the exact (version-dependent) encoding. */
function collectFelts(value: unknown): bigint[] {
  const felts: bigint[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === "object") Object.values(node).forEach(walk);
    else if (typeof node === "string") {
      try {
        felts.push(BigInt(node));
      } catch {
        // not a felt string; ignore
      }
    }
  };
  walk(value);
  return felts;
}

afterEach(() => {
  fetchMock.mockReset();
});

describe("SolanaAsStarknetAccount.upgrade", () => {
  it("rejects a zero class hash before touching the wire", async () => {
    const methods = mockRpc({});
    await expect(makeAccount().upgrade("0x0")).rejects.toThrow(/zero/i);
    expect(methods).toEqual([]);
  });

  it("rejects a missing (empty) class hash before touching the wire", async () => {
    const methods = mockRpc({});
    await expect(makeAccount().upgrade("")).rejects.toThrow(/missing/i);
    expect(methods).toEqual([]);
  });

  it("rejects a non-felt class hash before touching the wire", async () => {
    const methods = mockRpc({});
    await expect(makeAccount().upgrade("0xnothex")).rejects.toThrow(/not a valid felt/i);
    expect(methods).toEqual([]);
  });

  it("rejects an out-of-field class hash before touching the wire", async () => {
    const methods = mockRpc({});
    // 2**252 > STARK prime.
    await expect(makeAccount().upgrade("0x" + (2n ** 252n).toString(16))).rejects.toThrow(
      /out of the felt range/i,
    );
    expect(methods).toEqual([]);
  });

  it("rejects a negative class hash before touching the wire", async () => {
    const methods = mockRpc({});
    // BigInt("-1") parses fine, so the `=== 0n` / `>= PRIME` guards alone would let a
    // negative through and num.toHex would emit a malformed "0x-1"; it must be caught
    // as out-of-range instead. Any negative-decimal is rejected the same way.
    await expect(makeAccount().upgrade("-1")).rejects.toThrow(/out of the felt range/i);
    await expect(makeAccount().upgrade("-42")).rejects.toThrow(/out of the felt range/i);
    expect(methods).toEqual([]);
  });

  it("throws a declare-first error when the target class is not declared", async () => {
    let getClassArg: unknown;
    const methods = mockRpc(
      deployedNodeHandlers({
        starknet_getClass: (params) => {
          getClassArg = params;
          return new JsonRpcError(28, "Class hash not found");
        },
      }),
    );
    await expect(makeAccount().upgrade(TARGET_CLASS_HASH)).rejects.toThrow(
      /not declared on this network/i,
    );
    // The declared-class pre-check ran against the requested target, and nothing was
    // submitted through the paymaster.
    expect(collectFelts(getClassArg)).toContain(BigInt(TARGET_CLASS_HASH));
    expect(methods).not.toContain("paymaster_buildTransaction");
  });

  it("rethrows a non-CLASS_HASH_NOT_FOUND getClass error rather than misreport the class as undeclared", async () => {
    // getClass fails with a generic RPC error (code 40), NOT CLASS_HASH_NOT_FOUND
    // (code 28). The declare-first guidance must fire only for code 28; any other
    // failure has to propagate untouched so the caller sees the real error.
    const methods = mockRpc(
      deployedNodeHandlers({
        starknet_getClass: () => new JsonRpcError(40, "Contract error"),
      }),
    );

    let caught: unknown;
    await makeAccount()
      .upgrade(TARGET_CLASS_HASH)
      .catch((err) => {
        caught = err;
      });

    expect(caught).toBeInstanceOf(RpcError);
    expect((caught as Error).message).toMatch(/contract error/i);
    expect((caught as Error).message).not.toMatch(/not declared on this network/i);
    // A misclassification (treating any getClass failure as "declared, proceed")
    // would still submit through the paymaster; the rethrow must prevent that.
    expect(methods).not.toContain("paymaster_buildTransaction");
  });

  it("routes a sponsored upgrade invoke targeting self through the paymaster", async () => {
    let build: BuildParams | undefined;
    const upgradeCall: Call = {
      contractAddress: ACCOUNT_ADDRESS,
      entrypoint: "upgrade",
      calldata: [TARGET_CLASS_HASH],
    };
    const methods = mockRpc(
      deployedNodeHandlers({
        paymaster_buildTransaction: (params) => {
          build = params as BuildParams;
          return buildResult(typedDataFor([upgradeCall]));
        },
        paymaster_executeTransaction: () => ({ transaction_hash: "0x51", tracking_id: "0x1" }),
      }),
    );

    const res = await makeAccount().upgrade(TARGET_CLASS_HASH);

    expect(res.transaction_hash).toBe("0x51");
    // The sponsored path ran (build + execute); the declared-class pre-check ran too.
    expect(methods).toContain("starknet_getClass");
    expect(methods).toContain("paymaster_buildTransaction");
    expect(methods).toContain("paymaster_executeTransaction");
    // Exactly one call, targeting THIS account, via the upgrade selector, with the
    // requested target hash as its sole argument.
    const calls = build?.transaction.invoke.calls ?? [];
    expect(calls).toHaveLength(1);
    expect(BigInt(calls[0].to)).toBe(BigInt(ACCOUNT_ADDRESS));
    expect(BigInt(calls[0].selector)).toBe(UPGRADE_SELECTOR);
    expect(calls[0].calldata.map((felt) => BigInt(felt))).toEqual([BigInt(TARGET_CLASS_HASH)]);
    // The call target is the account itself, distinct from the class hash argument -
    // proving self-targeting rather than an accidental to/arg swap.
    expect(BigInt(calls[0].to)).not.toBe(BigInt(TARGET_CLASS_HASH));
  });

  it("targets self with the explicit target as the sole upgrade argument", async () => {
    let build: BuildParams | undefined;
    // Distinct from both the account address and any default, so a bug that used
    // either as the inner call target (or that dropped/replaced the argument) fails
    // this test.
    const explicitTarget = "0x1234";
    const upgradeCall: Call = {
      contractAddress: ACCOUNT_ADDRESS,
      entrypoint: "upgrade",
      calldata: [explicitTarget],
    };
    const methods = mockRpc(
      deployedNodeHandlers({
        paymaster_buildTransaction: (params) => {
          build = params as BuildParams;
          return buildResult(typedDataFor([upgradeCall]));
        },
        paymaster_executeTransaction: () => ({ transaction_hash: "0x53", tracking_id: "0x1" }),
      }),
    );

    const res = await makeAccount().upgrade(explicitTarget);

    expect(res.transaction_hash).toBe("0x53");
    expect(methods).toContain("paymaster_executeTransaction");
    const calls = build?.transaction.invoke.calls ?? [];
    expect(calls).toHaveLength(1);
    expect(BigInt(calls[0].to)).toBe(BigInt(ACCOUNT_ADDRESS));
    expect(BigInt(calls[0].selector)).toBe(UPGRADE_SELECTOR);
    expect(calls[0].calldata.map((felt) => BigInt(felt))).toEqual([BigInt(explicitTarget)]);
    // The call target is self - not the target class hash.
    expect(BigInt(calls[0].to)).not.toBe(BigInt(explicitTarget));
  });

  it("surfaces a paymaster refusal of the upgrade self-call as an error", async () => {
    // upgrade() runs sponsored like every account operation. A paymaster whose policy
    // does not allowlist the upgrade self-call refuses it, and that error surfaces
    // directly (there is no fallback execution path).
    const methods = mockRpc(
      deployedNodeHandlers({
        paymaster_buildTransaction: () => new JsonRpcError(155, "transaction sponsoring refused"),
      }),
    );

    const account = makeAccount({ nodeUrl: PAYMASTER_URL });
    await expect(account.upgrade(TARGET_CLASS_HASH)).rejects.toThrow(/sponsoring refused/);

    // The sponsored path was taken and the error propagated; nothing was executed.
    expect(methods).toContain("paymaster_buildTransaction");
    expect(methods).not.toContain("paymaster_executeTransaction");
  });
});
