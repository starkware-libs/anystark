import { afterEach, describe, expect, it, vi } from "vitest";

// starknet.js binds globalThis.fetch once, at module load (its internal
// fetch_default), so the mock must exist BEFORE the starknet import below —
// vi.hoisted runs ahead of the hoisted ESM imports. Tests swap implementations
// via mockRpc(); the function object itself must stay this one.
const { fetchMock, realFetch } = vi.hoisted(() => {
  const realFetch = globalThis.fetch;
  const fetchMock = vi.fn<(url: unknown, init?: RequestInit) => Promise<Response>>();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return { fetchMock, realFetch };
});

import { Account, OutsideExecutionVersion, constants, outsideExecution, type Call } from "starknet";
import { SolanaAsStarknetAccount } from "./account";
import { CHAIN_IDS, type PaymasterConfig } from "./config";
import { SOL_ACCOUNT_CLASS_HASHES, deriveSolAccountAddress } from "./key_to_address";
import { LOCKED_PUBKEY, lockedEd25519Signer } from "./test_vectors";

// Locked derivation vector (see key_to_address.test.ts).
const PUBKEY = Uint8Array.from(Array.from({ length: 32 }, (_, i) => i));
const CLASS_HASH = SOL_ACCOUNT_CLASS_HASHES[CHAIN_IDS.sepolia];
const EXPECTED_ADDRESS = "0x3011dc8056908306c2c0fbf47a0d470318e1871323311951eff05d333bfc7b7";

const signer = { pubkey: PUBKEY, signBytes: async () => new Uint8Array(64) };

function makeAccount() {
  return new SolanaAsStarknetAccount({
    signer,
    rpcUrl: "http://localhost:5050",
    classHash: CLASS_HASH,
    paymaster: { nodeUrl: "http://paymaster.localhost" },
  });
}

describe("SolanaAsStarknetAccount", () => {
  it("is a starknet.js Account (drop-in for AccountInterface)", () => {
    expect(makeAccount()).toBeInstanceOf(Account);
  });

  it("uses the counterfactual address derived from the pubkey + class hash", () => {
    expect(makeAccount().address).toBe(EXPECTED_ADDRESS);
  });

  it("exposes the full derivation (matches deriveSolAccountAddress)", () => {
    expect(makeAccount().derivation).toEqual(deriveSolAccountAddress(PUBKEY, CLASS_HASH));
  });
});

// ─── SNIP-29 sponsored execution ───
// All network traffic — Starknet node and paymaster alike — is mocked at the
// fetch level: a JSON-RPC router per test, so the assertions pin the exact wire
// methods each path may (and may not) touch.

/** A JSON-RPC error for a mock handler to return instead of a `result`. */
class JsonRpcError {
  constructor(
    readonly code: number,
    readonly message: string,
  ) {}
}

/** Route JSON-RPC requests to per-method handlers. Returns the ordered log of
 *  requested methods for may/may-not-touch assertions. */
function mockRpc(handlers: Record<string, (params: unknown) => unknown>): string[] {
  const methods: string[] = [];
  fetchMock.mockImplementation(async (url, init) => {
    // Only JSON-RPC POSTs are routed; bodiless requests (garaga fetching its own
    // WASM binary) fall through to the real fetch.
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

const PAYMASTER_URL = "http://paymaster.localhost";
// The sponsored account signs for real (locked Ed25519 key), so its address
// derives from LOCKED_PUBKEY — not the derivation-vector PUBKEY above.
const SPONSORED_ACCOUNT = deriveSolAccountAddress(LOCKED_PUBKEY, CLASS_HASH);
const CALLS: Call[] = [{ contractAddress: "0x5678", entrypoint: "transfer", calldata: ["0xcafe"] }];
/** The paymaster's outside-execution validity window (execute_before) in the mock
 *  issued typed data; named to mirror the e2e's EXECUTION_WINDOW_SECS. */
const EXECUTION_WINDOW_SECS = 3600;

function makeSponsoredAccount(paymaster: PaymasterConfig = { nodeUrl: PAYMASTER_URL }) {
  return new SolanaAsStarknetAccount({
    signer: lockedEd25519Signer(),
    rpcUrl: "http://localhost:5050",
    classHash: CLASS_HASH,
    paymaster,
  });
}

/** A sponsored account whose signBytes is spied — signBytes is the terminal
 *  wallet call, so `not.toHaveBeenCalled()` proves a guard rejection fired BEFORE
 *  anything was signed (not merely before it reached the paymaster). */
function makeSpiedSponsoredAccount(paymaster: PaymasterConfig = { nodeUrl: PAYMASTER_URL }) {
  const base = lockedEd25519Signer();
  const signBytes = vi.fn(base.signBytes);
  const account = new SolanaAsStarknetAccount({
    signer: { pubkey: base.pubkey, signBytes },
    rpcUrl: "http://localhost:5050",
    classHash: CLASS_HASH,
    paymaster,
  });
  return { account, signBytes };
}

/** SNIP-9 v2 typed data as an honest paymaster would build it for `calls`. */
function typedDataFor(calls: Call[]) {
  return outsideExecution.getTypedData(
    CHAIN_IDS.sepolia,
    {
      caller: constants.OutsideExecutionCallerAny,
      execute_after: 0,
      execute_before: EXECUTION_WINDOW_SECS,
    },
    "0x1",
    calls,
    OutsideExecutionVersion.V2,
  );
}

const PAYMASTER_FEE = {
  gas_token_price_in_strk: "0x0",
  estimated_fee_in_strk: "0x0",
  estimated_fee_in_gas_token: "0x0",
  suggested_max_fee_in_strk: "0x0",
  suggested_max_fee_in_gas_token: "0x0",
};

/** paymaster_buildTransaction result wrapping `typed_data` (+ deployment echo). */
function buildResult(typed_data: unknown, deployment?: unknown) {
  const parameters = { version: "0x1", fee_mode: { mode: "sponsored" } };
  return deployment
    ? { type: "deploy_and_invoke", deployment, typed_data, parameters, fee: PAYMASTER_FEE }
    : { type: "invoke", typed_data, parameters, fee: PAYMASTER_FEE };
}

// ─── default (gas-token) fee mode fixtures ───
const GAS_TOKEN = "0xfee";
const GAS_FEE_MODE = { mode: "default", gasToken: GAS_TOKEN, maxFeeInGasToken: 100n } as const;

/** The gas-token repayment call the paymaster appends in `default` mode:
 *  transfer(recipient, amount: u256) → [recipient, amount_low, amount_high]. */
function gasTransfer(amountHex: string, token = GAS_TOKEN, recipient = "0x5178"): Call {
  return {
    contractAddress: token,
    entrypoint: "transfer",
    calldata: [recipient, amountHex, "0x0"],
  };
}

/** default-mode build result quoting `feeInGasToken`. The echoed `parameters` are
 *  not read by the guard (it binds our config feeMode + fee), so a sponsored-shaped
 *  echo is fine — the wire fee_mode we SEND is asserted from the request instead. */
function defaultBuildResult(calls: Call[], feeInGasToken: string) {
  return {
    type: "invoke",
    typed_data: typedDataFor(calls),
    parameters: { version: "0x1", fee_mode: { mode: "sponsored" } },
    fee: { ...PAYMASTER_FEE, suggested_max_fee_in_gas_token: feeInGasToken },
  };
}

/** Starknet-node handlers common to every scenario. `deployed` steers the
 *  getClassHashAt probe behind isDeployed(). */
function nodeHandlers(deployed: boolean): Record<string, (params: unknown) => unknown> {
  return {
    starknet_specVersion: () => "0.9.0",
    starknet_chainId: () => CHAIN_IDS.sepolia,
    starknet_getClassHashAt: () =>
      deployed ? CLASS_HASH : new JsonRpcError(20, "Contract not found"),
  };
}

type BuildParams = {
  transaction: { type: string; deployment?: Record<string, unknown>; invoke?: unknown };
  parameters: unknown;
};

/** Handlers that let the background deploy waiter (waitForTransaction) resolve. */
function acceptHandlers(): Record<string, (params: unknown) => unknown> {
  return {
    starknet_getTransactionStatus: () => ({
      finality_status: "ACCEPTED_ON_L2",
      execution_status: "SUCCEEDED",
    }),
    starknet_getTransactionReceipt: () => ({
      type: "INVOKE",
      transaction_hash: "0x0",
      actual_fee: { amount: "0x0", unit: "FRI" },
      execution_status: "SUCCEEDED",
      finality_status: "ACCEPTED_ON_L2",
      block_hash: "0x1",
      block_number: 1,
      messages_sent: [],
      events: [],
      execution_resources: { l1_gas: 0, l1_data_gas: 0, l2_gas: 0 },
    }),
  };
}

afterEach(() => {
  fetchMock.mockReset();
});

describe("SolanaAsStarknetAccount.execute with a paymaster", () => {
  it("routes through the paymaster: build + execute, no fee estimation, no self-deploy", async () => {
    const account = makeSponsoredAccount();
    let build: BuildParams | undefined;
    const methods = mockRpc({
      ...nodeHandlers(true),
      paymaster_buildTransaction: (params) => {
        build = params as BuildParams;
        return buildResult(typedDataFor(CALLS));
      },
      paymaster_executeTransaction: () => ({ transaction_hash: "0x50", tracking_id: "0x1" }),
    });

    const res = await account.execute(CALLS);

    expect(res.transaction_hash).toBe("0x50");
    expect(methods).toContain("paymaster_buildTransaction");
    expect(methods).toContain("paymaster_executeTransaction");
    // No protocol-transaction pipeline runs in the sponsored path.
    expect(methods).not.toContain("starknet_estimateFee");
    expect(methods).not.toContain("starknet_addInvokeTransaction");
    expect(methods).not.toContain("starknet_addDeployAccountTransaction");
    // Deployed account: a plain invoke for THIS account, sponsored by default.
    expect(build?.transaction.type).toBe("invoke");
    expect(build?.transaction).not.toHaveProperty("deployment");
    expect(build?.transaction.invoke).toMatchObject({ user_address: SPONSORED_ACCOUNT.address });
    expect(build?.parameters).toEqual({ version: "0x1", fee_mode: { mode: "sponsored" } });
  });

  it("rejects typed data with an extra call before signing (sponsored allows none)", async () => {
    const account = makeSponsoredAccount();
    const sneaky = typedDataFor([
      ...CALLS,
      { contractAddress: "0xdead", entrypoint: "transfer", calldata: ["0x1"] },
    ]);
    const methods = mockRpc({
      ...nodeHandlers(true),
      paymaster_buildTransaction: () => buildResult(sneaky),
    });

    await expect(account.execute(CALLS)).rejects.toThrow(
      /refusing to sign calls that were not requested/,
    );
    expect(methods).not.toContain("paymaster_executeTransaction");
  });

  it("rejects typed data whose calldata was mutated, before signing", async () => {
    const account = makeSponsoredAccount();
    const tampered = typedDataFor([{ ...CALLS[0], calldata: ["0xcaff"] }]);
    const methods = mockRpc({
      ...nodeHandlers(true),
      paymaster_buildTransaction: () => buildResult(tampered),
    });

    await expect(account.execute(CALLS)).rejects.toThrow(/calldata\[0\]/);
    expect(methods).not.toContain("paymaster_executeTransaction");
  });

  it("rejects a response bound to a different account address, before signing", async () => {
    const account = makeSponsoredAccount();
    const methods = mockRpc({
      ...nodeHandlers(false), // undeployed → the request carries deploymentData
      paymaster_buildTransaction: (params) => {
        const sent = (params as BuildParams).transaction.deployment!;
        return buildResult(typedDataFor(CALLS), { ...sent, address: "0xdead" });
      },
    });

    await expect(account.execute(CALLS)).rejects.toThrow(/deployment echo: address/);
    expect(methods).not.toContain("paymaster_executeTransaction");
  });

  // The remaining deployment-echo branches (class_hash / salt / calldata), parallel
  // to the address case above — cheap defense-in-depth (the real binding is the
  // SNIP-12 hash folding this.address; the echo check is belt-and-braces).
  it.each<[string, (sent: Record<string, unknown>) => Record<string, unknown>, RegExp]>([
    ["class_hash", (sent) => ({ ...sent, class_hash: "0xdead" }), /deployment echo: class_hash/],
    ["salt", (sent) => ({ ...sent, salt: "0xdead" }), /deployment echo: salt/],
    [
      "calldata value",
      (sent) => ({ ...sent, calldata: ["0xdead", ...(sent.calldata as string[]).slice(1)] }),
      /deployment echo: calldata\[0\]/,
    ],
    [
      "calldata length",
      (sent) => ({ ...sent, calldata: [...(sent.calldata as string[]), "0x1"] }),
      /deployment echo: calldata length/,
    ],
  ])(
    "rejects a deployment echo whose %s was tampered, before signing",
    async (_field, tamper, message) => {
      const { account, signBytes } = makeSpiedSponsoredAccount();
      const methods = mockRpc({
        ...nodeHandlers(false), // undeployed → the request carries deploymentData
        paymaster_buildTransaction: (params) => {
          const sent = (params as BuildParams).transaction.deployment!;
          return buildResult(typedDataFor(CALLS), tamper(sent));
        },
      });
      await expect(account.execute(CALLS)).rejects.toThrow(message);
      expect(methods).not.toContain("paymaster_executeTransaction");
      expect(signBytes).not.toHaveBeenCalled();
    },
  );

  it("bundles SNIP-29 deploymentData (from the derivation) when undeployed", async () => {
    const account = makeSponsoredAccount();
    let build: BuildParams | undefined;
    const methods = mockRpc({
      ...nodeHandlers(false),
      paymaster_buildTransaction: (params) => {
        build = params as BuildParams;
        return buildResult(typedDataFor(CALLS), build.transaction.deployment);
      },
      paymaster_executeTransaction: () => ({ transaction_hash: "0x52", tracking_id: "0x1" }),
      // The post-deploy waiter (memoized for concurrent calls) polls in the
      // background; resolve it immediately.
      starknet_getTransactionStatus: () => ({
        finality_status: "ACCEPTED_ON_L2",
        execution_status: "SUCCEEDED",
      }),
      starknet_getTransactionReceipt: () => ({
        type: "INVOKE",
        transaction_hash: "0x52",
        actual_fee: { amount: "0x0", unit: "FRI" },
        execution_status: "SUCCEEDED",
        finality_status: "ACCEPTED_ON_L2",
        block_hash: "0x1",
        block_number: 1,
        messages_sent: [],
        events: [],
        execution_resources: { l1_gas: 0, l1_data_gas: 0, l2_gas: 0 },
      }),
    });

    const res = await account.execute(CALLS);

    expect(res.transaction_hash).toBe("0x52");
    expect(methods).toContain("paymaster_executeTransaction");
    expect(build?.transaction.type).toBe("deploy_and_invoke");
    // The deployment payload is exactly the counterfactual derivation.
    expect(build?.transaction.deployment).toEqual({
      address: SPONSORED_ACCOUNT.address,
      class_hash: CLASS_HASH,
      salt: SPONSORED_ACCOUNT.salt,
      calldata: SPONSORED_ACCOUNT.calldata,
      version: 1,
    });
  });

  it("propagates paymaster errors as-is, executing nothing else", async () => {
    const account = makeSponsoredAccount();
    const methods = mockRpc({
      ...nodeHandlers(true),
      paymaster_buildTransaction: () => new JsonRpcError(155, "transaction sponsoring refused"),
    });

    await expect(account.execute(CALLS)).rejects.toThrow(/sponsoring refused/);
    // The error propagates; no paymaster execution and no protocol transaction happened.
    expect(methods).not.toContain("paymaster_executeTransaction");
    expect(methods).not.toContain("starknet_estimateFee");
    expect(methods).not.toContain("starknet_addInvokeTransaction");
    // Explicit (future-proof) form: nothing beyond the sponsored preamble touched
    // the wire: no protocol-transaction fingerprint (nonce/simulate/tip scan) slipped in.
    expect(
      methods.filter(
        (m) =>
          ![
            "starknet_specVersion",
            "starknet_chainId",
            "starknet_getClassHashAt",
            "paymaster_buildTransaction",
          ].includes(m),
      ),
    ).toEqual([]);
  });

  // ─── guard negatives: each tampered field must reject (before signing) ───

  // Each row asserts its own field-specific suffix (not just the shared prefix), so
  // the case proves WHICH per-call branch fired; the signer spy proves each fired
  // before signing.
  it.each<[string, ReturnType<typeof typedDataFor>, RegExp]>([
    ["To", typedDataFor([{ ...CALLS[0], contractAddress: "0xdead" }]), /To .* !=/],
    ["Selector", typedDataFor([{ ...CALLS[0], entrypoint: "approve" }]), /Selector .* !=/],
    [
      "calldata length",
      typedDataFor([{ ...CALLS[0], calldata: ["0xcafe", "0x1"] }]),
      /calldata length/,
    ],
  ])(
    "rejects typed data whose %s was tampered, before signing",
    async (_field, tampered, message) => {
      const { account, signBytes } = makeSpiedSponsoredAccount();
      const methods = mockRpc({
        ...nodeHandlers(true),
        paymaster_buildTransaction: () => buildResult(tampered),
      });
      await expect(account.execute(CALLS)).rejects.toThrow(message);
      expect(methods).not.toContain("paymaster_executeTransaction");
      expect(signBytes).not.toHaveBeenCalled();
    },
  );

  it("rejects non-SNIP-9-v2 typed data (message has no Calls), before signing", async () => {
    const account = makeSponsoredAccount();
    const v1Shaped = {
      domain: { chainId: CHAIN_IDS.sepolia, name: "Account.execute_from_outside", version: "1" },
      primaryType: "OutsideExecution",
      types: {},
      message: { calls: [] },
    };
    const methods = mockRpc({
      ...nodeHandlers(true),
      paymaster_buildTransaction: () => buildResult(v1Shaped),
    });
    await expect(account.execute(CALLS)).rejects.toThrow(/non-SNIP-9-v2/);
    expect(methods).not.toContain("paymaster_executeTransaction");
  });

  it("rejects a wrong-chain typed-data domain (cross-network replay), before signing", async () => {
    const account = makeSponsoredAccount();
    const wrongChain = outsideExecution.getTypedData(
      CHAIN_IDS.mainnet, // node reports sepolia (nodeHandlers below)
      {
        caller: constants.OutsideExecutionCallerAny,
        execute_after: 0,
        execute_before: EXECUTION_WINDOW_SECS,
      },
      "0x1",
      CALLS,
      OutsideExecutionVersion.V2,
    );
    const methods = mockRpc({
      ...nodeHandlers(true),
      paymaster_buildTransaction: () => buildResult(wrongChain),
    });
    await expect(account.execute(CALLS)).rejects.toThrow(/domain chainId .* does not match/);
    expect(methods).not.toContain("paymaster_executeTransaction");
  });

  it("accepts a domain chainId in ASCII shortstring form (SN_SEPOLIA), same chain", async () => {
    const account = makeSponsoredAccount();
    const td = typedDataFor(CALLS);
    // A paymaster built via starknet.js may emit the chainId as its shortstring
    // rather than the RPC hex felt; both encode to the same felt and must be accepted
    // (a clean equal-chain, not a BigInt(...) throw).
    const shortStringChain = { ...td, domain: { ...td.domain, chainId: "SN_SEPOLIA" } };
    const methods = mockRpc({
      ...nodeHandlers(true),
      paymaster_buildTransaction: () => buildResult(shortStringChain),
      paymaster_executeTransaction: () => ({ transaction_hash: "0x63", tracking_id: "0x1" }),
    });
    const res = await account.execute(CALLS);
    expect(res.transaction_hash).toBe("0x63");
    expect(methods).toContain("paymaster_executeTransaction");
  });

  it("rejects when the paymaster changes the transaction type, before signing", async () => {
    const account = makeSponsoredAccount();
    const methods = mockRpc({
      ...nodeHandlers(true), // deployed → request is a plain "invoke"
      paymaster_buildTransaction: () => ({
        type: "deploy",
        deployment: {},
        parameters: { version: "0x1", fee_mode: { mode: "sponsored" } },
        fee: PAYMASTER_FEE,
      }),
    });
    await expect(account.execute(CALLS)).rejects.toThrow(/changed the transaction type/);
    expect(methods).not.toContain("paymaster_executeTransaction");
  });

  it("verifies the guard BEFORE signing (the signer is never invoked on a bad response)", async () => {
    const { account, signBytes } = makeSpiedSponsoredAccount();
    const sneaky = typedDataFor([
      ...CALLS,
      { contractAddress: "0xdead", entrypoint: "transfer", calldata: ["0x1"] },
    ]);
    mockRpc({ ...nodeHandlers(true), paymaster_buildTransaction: () => buildResult(sneaky) });
    await expect(account.execute(CALLS)).rejects.toThrow();
    expect(signBytes).not.toHaveBeenCalled();
  });

  it("forwards configured headers to the paymaster only (API-key channel)", async () => {
    const account = makeSponsoredAccount({ nodeUrl: PAYMASTER_URL, headers: { "x-api-key": "k" } });
    const headersByMethod: Record<string, Headers> = {};
    const handlers: Record<string, (params: unknown) => unknown> = {
      ...nodeHandlers(true),
      paymaster_buildTransaction: () => buildResult(typedDataFor(CALLS)),
      paymaster_executeTransaction: () => ({ transaction_hash: "0x71", tracking_id: "0x1" }),
    };
    fetchMock.mockImplementation(async (url, init) => {
      if (init?.body === undefined) return realFetch(url as RequestInfo, init);
      const body = JSON.parse(String(init.body)) as {
        id: number;
        method: string;
        params?: unknown;
      };
      headersByMethod[body.method] = new Headers(init.headers);
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result: handlers[body.method](body.params) }),
      );
    });

    await account.execute(CALLS);

    expect(headersByMethod["paymaster_buildTransaction"]?.get("x-api-key")).toBe("k");
    expect(headersByMethod["starknet_getClassHashAt"]?.get("x-api-key")).toBeNull();
  });

  // ─── deploy memoization: TOCTOU + positive caching + failure reset ───

  it("shares one deploy across concurrent first-use executes (no double deploy_and_invoke)", async () => {
    vi.useFakeTimers();
    try {
      const account = makeSponsoredAccount();
      const buildTypes: string[] = [];
      const methods = mockRpc({
        ...nodeHandlers(false),
        paymaster_buildTransaction: (params) => {
          const tx = (params as BuildParams).transaction;
          buildTypes.push(tx.type);
          return tx.type === "deploy_and_invoke"
            ? buildResult(typedDataFor(CALLS), tx.deployment)
            : buildResult(typedDataFor(CALLS));
        },
        paymaster_executeTransaction: () => ({ transaction_hash: "0x80", tracking_id: "0x1" }),
        ...acceptHandlers(),
      });

      const settled = Promise.all([account.execute(CALLS), account.execute(CALLS)]);
      // Drive the background deploy waiter (default 5s poll) to completion so the
      // concurrent second execute() can proceed to its plain invoke — runAll drains
      // the interleaved fetch microtasks + poll timers deterministically.
      await vi.runAllTimersAsync();
      const [a, b] = await settled;

      expect(a.transaction_hash).toBe("0x80");
      expect(b.transaction_hash).toBe("0x80");
      // Exactly ONE deployment bundled; the second execute() plain-invokes.
      expect(buildTypes.filter((t) => t === "deploy_and_invoke")).toHaveLength(1);
      expect(methods.filter((m) => m === "paymaster_executeTransaction")).toHaveLength(2);
      // The isDeployed() probe ran once (claimed synchronously), not per call.
      expect(methods.filter((m) => m === "starknet_getClassHashAt")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caches a positive deployment: a second sponsored execute skips getClassHashAt", async () => {
    const account = makeSponsoredAccount();
    const methods = mockRpc({
      ...nodeHandlers(true),
      paymaster_buildTransaction: () => buildResult(typedDataFor(CALLS)),
      paymaster_executeTransaction: () => ({ transaction_hash: "0x90", tracking_id: "0x1" }),
    });

    await account.execute(CALLS);
    await account.execute(CALLS);

    expect(methods.filter((m) => m === "starknet_getClassHashAt")).toHaveLength(1);
    expect(methods.filter((m) => m === "paymaster_executeTransaction")).toHaveLength(2);
  });

  it("resets the deploy memo after a failed first execute so a retry can redeploy", async () => {
    const account = makeSponsoredAccount();
    let honest = false;
    const buildTypes: string[] = [];
    const methods = mockRpc({
      ...nodeHandlers(false),
      paymaster_buildTransaction: (params) => {
        const tx = (params as BuildParams).transaction;
        buildTypes.push(tx.type);
        if (!honest) return new JsonRpcError(155, "transaction sponsoring refused");
        return buildResult(typedDataFor(CALLS), tx.deployment);
      },
      paymaster_executeTransaction: () => ({ transaction_hash: "0xa0", tracking_id: "0x1" }),
      ...acceptHandlers(),
    });

    await expect(account.execute(CALLS)).rejects.toThrow(/sponsoring refused/);
    honest = true;
    const res = await account.execute(CALLS);

    expect(res.transaction_hash).toBe("0xa0");
    // Both attempts bundled a fresh deploy_and_invoke (the memo reset on failure).
    expect(buildTypes.filter((t) => t === "deploy_and_invoke")).toHaveLength(2);
    expect(methods).toContain("paymaster_executeTransaction");
  });

  // ─── default (gas-token) fee mode: the SDK guard is the ONLY amount binding ───

  it("default fee mode: signs and submits a bounded gas-token repayment", async () => {
    const account = makeSponsoredAccount({ nodeUrl: PAYMASTER_URL, feeMode: GAS_FEE_MODE });
    let build: BuildParams | undefined;
    const methods = mockRpc({
      ...nodeHandlers(true),
      paymaster_buildTransaction: (params) => {
        build = params as BuildParams;
        return defaultBuildResult([...CALLS, gasTransfer("0x64")], "0x64");
      },
      paymaster_executeTransaction: () => ({ transaction_hash: "0x61", tracking_id: "0x1" }),
    });

    const res = await account.execute(CALLS);

    expect(res.transaction_hash).toBe("0x61");
    expect(methods).toContain("paymaster_executeTransaction");
    // The wire fee_mode we SEND is the SNIP-29 gas-token form (no caller ceiling).
    expect(build?.parameters).toEqual({
      version: "0x1",
      fee_mode: { mode: "default", gas_token: GAS_TOKEN },
    });
  });

  it("default fee mode: rejects an appended amount above the quoted fee, before signing", async () => {
    const account = makeSponsoredAccount({ nodeUrl: PAYMASTER_URL, feeMode: GAS_FEE_MODE });
    const methods = mockRpc({
      ...nodeHandlers(true),
      // quote 0x64, but the appended transfer pulls 0x65.
      paymaster_buildTransaction: () => defaultBuildResult([...CALLS, gasTransfer("0x65")], "0x64"),
    });
    await expect(account.execute(CALLS)).rejects.toThrow(/does not equal the quoted fee/);
    expect(methods).not.toContain("paymaster_executeTransaction");
  });

  it("default fee mode: rejects a quoted fee above maxFeeInGasToken, before signing", async () => {
    const account = makeSponsoredAccount({ nodeUrl: PAYMASTER_URL, feeMode: GAS_FEE_MODE });
    const methods = mockRpc({
      ...nodeHandlers(true),
      // 0x65 == 101 > the configured maxFeeInGasToken (100).
      paymaster_buildTransaction: () => defaultBuildResult([...CALLS, gasTransfer("0x65")], "0x65"),
    });
    await expect(account.execute(CALLS)).rejects.toThrow(/exceeds the configured maxFeeInGasToken/);
    expect(methods).not.toContain("paymaster_executeTransaction");
  });

  it("default fee mode: rejects a repayment not to the configured gas token, before signing", async () => {
    const account = makeSponsoredAccount({ nodeUrl: PAYMASTER_URL, feeMode: GAS_FEE_MODE });
    const methods = mockRpc({
      ...nodeHandlers(true),
      paymaster_buildTransaction: () =>
        defaultBuildResult([...CALLS, gasTransfer("0x64", "0xdead")], "0x64"),
    });
    await expect(account.execute(CALLS)).rejects.toThrow(/not the configured gas token/);
    expect(methods).not.toContain("paymaster_executeTransaction");
  });

  it("default fee mode: rejects a repayment that is not a transfer, before signing", async () => {
    const account = makeSponsoredAccount({ nodeUrl: PAYMASTER_URL, feeMode: GAS_FEE_MODE });
    const approve: Call = {
      contractAddress: GAS_TOKEN,
      entrypoint: "approve",
      calldata: ["0x5178", "0x64", "0x0"],
    };
    const methods = mockRpc({
      ...nodeHandlers(true),
      paymaster_buildTransaction: () => defaultBuildResult([...CALLS, approve], "0x64"),
    });
    await expect(account.execute(CALLS)).rejects.toThrow(/not an ERC-20 transfer/);
    expect(methods).not.toContain("paymaster_executeTransaction");
  });

  it("default fee mode: rejects when no gas-token repayment call is appended", async () => {
    const account = makeSponsoredAccount({ nodeUrl: PAYMASTER_URL, feeMode: GAS_FEE_MODE });
    const methods = mockRpc({
      ...nodeHandlers(true),
      paymaster_buildTransaction: () => defaultBuildResult([...CALLS], "0x64"),
    });
    await expect(account.execute(CALLS)).rejects.toThrow(/expected 2/);
    expect(methods).not.toContain("paymaster_executeTransaction");
  });
});
