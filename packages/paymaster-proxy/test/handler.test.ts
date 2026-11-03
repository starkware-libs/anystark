import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  handlePaymasterRequest,
  InMemoryRateLimitStore,
  type ProxyConfig,
} from "../src/handler.js";
import type { SponsorshipPolicy } from "../src/policy.js";

// Shape of a JSON-RPC response body, used to narrow the handler's `unknown` body
// in assertions without reaching for `any`.
type RpcResponse = {
  result?: unknown;
  error?: { code: number; message: string };
};
const asRpc = (body: unknown) => body as RpcResponse;

const TARGET = "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7";
const SELECTOR = "0x0083afd3f4caedc6eebf44246fe54e38c95e3179a5ec9ea81740eca5b482d12e";
const API_KEY = "super-secret-key-do-not-leak";

const policy: SponsorshipPolicy = {
  allowedCalls: [{ to: TARGET, selectors: [SELECTOR] }],
  sponsoredClassHashes: [],
  rateLimit: { maxPerAddress: 2, windowSec: 60 },
  // Tests use the in-memory store; opt into it explicitly so the fail-closed
  // guard does not trip. A dedicated test below exercises the guard itself.
  allowInMemoryStore: true,
};

function makeConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    upstreamUrl: "https://upstream.example/paymaster",
    apiKey: API_KEY,
    policy,
    store: new InMemoryRateLimitStore(),
    ...overrides,
  };
}

function buildReq(
  calls: { to: string; selector: string }[],
  user_address = "0x1",
  parameters: unknown = {},
) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "paymaster_buildTransaction",
    params: { transaction: { type: "invoke", invoke: { user_address, calls } }, parameters },
  };
}

// executeTransaction: calls live inside the signed SNIP-12 typed data with
// capitalized To/Selector fields.
function executeReq(
  calls: { To: string; Selector: string }[],
  user_address = "0x1",
  parameters: unknown = {},
) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "paymaster_executeTransaction",
    params: {
      transaction: {
        type: "invoke",
        invoke: {
          user_address,
          typed_data: { domain: { version: "2", revision: "1" }, message: { Calls: calls } },
        },
      },
      parameters,
    },
  };
}

function okFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
}

// Parse the body the handler forwarded to upstream on call `n` (default first).
function forwardedBody(fetchSpy: ReturnType<typeof vi.spyOn>, n = 0) {
  const [, init] = fetchSpy.mock.calls[n]!;
  return JSON.parse((init as RequestInit).body as string);
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("handlePaymasterRequest", () => {
  it("rejects an unknown method with -32601 and does not call upstream", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { status, body } = await handlePaymasterRequest(
      { jsonrpc: "2.0", id: 7, method: "eth_blockNumber", params: [] },
      makeConfig(),
    );
    expect(status).toBe(200);
    expect(asRpc(body).error!.code).toBe(-32601);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("denies a non-allowlisted call and does NOT call upstream", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { body } = await handlePaymasterRequest(
      buildReq([{ to: "0xdead", selector: SELECTOR }]),
      makeConfig(),
    );
    expect(asRpc(body).error).toBeDefined();
    expect(asRpc(body).error!.message).toMatch(/Sponsorship denied/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never leaks the api key into the response and forwards it as a header", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { typed_data: {} } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const { body } = await handlePaymasterRequest(
      buildReq([{ to: TARGET, selector: SELECTOR }]),
      makeConfig(),
    );

    // Key was injected as the upstream header.
    const [, init] = fetchSpy.mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["x-paymaster-api-key"]).toBe(API_KEY);

    // Key appears nowhere in the response payload.
    expect(JSON.stringify(body)).not.toContain(API_KEY);
  });

  it("passes through paymaster_isAvailable without a policy check", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { body } = await handlePaymasterRequest(
      { jsonrpc: "2.0", id: 1, method: "paymaster_isAvailable", params: [] },
      makeConfig(),
    );
    expect(asRpc(body).result).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("rate-limits per account after maxPerAddress build requests", async () => {
    // Fresh Response per call: a Response body can only be consumed once.
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const config = makeConfig(); // maxPerAddress = 2
    const req = () =>
      handlePaymasterRequest(buildReq([{ to: TARGET, selector: SELECTOR }]), config);

    expect(asRpc((await req()).body)).not.toHaveProperty("error");
    expect(asRpc((await req()).body)).not.toHaveProperty("error");
    const third = asRpc((await req()).body);
    expect(third.error).toBeDefined();
    expect(third.error!.message).toMatch(/Rate limit/);
  });

  it("returns an internal error (not the key) when upstream fetch throws", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const { body } = await handlePaymasterRequest(
      buildReq([{ to: TARGET, selector: SELECTOR }]),
      makeConfig(),
    );
    expect(asRpc(body).error!.code).toBe(-32603);
    expect(JSON.stringify(body)).not.toContain(API_KEY);
  });

  it("returns a parse error for invalid JSON", async () => {
    const { body } = await handlePaymasterRequest("{not json", makeConfig());
    expect(asRpc(body).error!.code).toBe(-32700);
  });

  it("normalizes an upstream non-2xx into INTERNAL_ERROR without relaying its body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "upstream rate limited", internal: "secret-detail" }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { status, body } = await handlePaymasterRequest(
      buildReq([{ to: TARGET, selector: SELECTOR }]),
      makeConfig(),
    );
    expect(status).toBe(200);
    expect(asRpc(body).error!.code).toBe(-32603);
    expect(JSON.stringify(body)).not.toContain("secret-detail");
  });

  // --- C1: enforce the allowlist on executeTransaction, not just build ---

  it("denies an executeTransaction with a non-allowlisted typed_data call and does NOT call upstream", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { body } = await handlePaymasterRequest(
      executeReq([{ To: "0xdead", Selector: SELECTOR }]),
      makeConfig(),
    );
    expect(asRpc(body).error).toBeDefined();
    expect(asRpc(body).error!.message).toMatch(/Sponsorship denied/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows an allowlisted executeTransaction and forwards it", async () => {
    const fetchSpy = okFetch();
    const { body } = await handlePaymasterRequest(
      executeReq([{ To: TARGET, Selector: SELECTOR }]),
      makeConfig(),
    );
    expect(asRpc(body)).not.toHaveProperty("error");
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(forwardedBody(fetchSpy).method).toBe("paymaster_executeTransaction");
  });

  it("rate limit applies on executeTransaction", async () => {
    okFetch();
    const config = makeConfig(); // maxPerAddress = 2
    const req = () =>
      handlePaymasterRequest(executeReq([{ To: TARGET, Selector: SELECTOR }], "0x9"), config);
    expect(asRpc((await req()).body)).not.toHaveProperty("error");
    expect(asRpc((await req()).body)).not.toHaveProperty("error");
    const third = asRpc((await req()).body);
    expect(third.error!.message).toMatch(/Rate limit/);
  });

  // --- H4: force sponsored fee mode, strip/clamp client tips ---

  it("strips a client-supplied tip before forwarding", async () => {
    const fetchSpy = okFetch();
    await handlePaymasterRequest(
      buildReq([{ to: TARGET, selector: SELECTOR }], "0x1", {
        version: "0x1",
        fee_mode: { mode: "sponsored", tip: 999 },
        tip: 999,
      }),
      makeConfig(),
    );
    const parameters = forwardedBody(fetchSpy).params.parameters;
    expect(parameters.fee_mode).toEqual({ mode: "sponsored" });
    expect(parameters.tip).toBeUndefined();
  });

  it("overrides a client gas-token fee_mode to sponsored", async () => {
    const fetchSpy = okFetch();
    await handlePaymasterRequest(
      buildReq([{ to: TARGET, selector: SELECTOR }], "0x1", {
        version: "0x1",
        fee_mode: { mode: "gas_token", gas_token: "0xusdc" },
      }),
      makeConfig(),
    );
    const parameters = forwardedBody(fetchSpy).params.parameters;
    expect(parameters.fee_mode.mode).toBe("sponsored");
    expect(parameters.fee_mode.gas_token).toBeUndefined();
  });

  it("also sanitizes parameters on executeTransaction", async () => {
    const fetchSpy = okFetch();
    await handlePaymasterRequest(
      executeReq([{ To: TARGET, Selector: SELECTOR }], "0x1", {
        fee_mode: { mode: "gas_token", gas_token: "0xusdc", tip: 5 },
      }),
      makeConfig(),
    );
    expect(forwardedBody(fetchSpy).params.parameters.fee_mode).toEqual({ mode: "sponsored" });
  });

  it("clamps a client tip to policy.maxTip when configured", async () => {
    const fetchSpy = okFetch();
    const config = makeConfig({ policy: { ...policy, maxTip: 10 } });
    await handlePaymasterRequest(
      buildReq([{ to: TARGET, selector: SELECTOR }], "0x1", {
        fee_mode: { mode: "sponsored", tip: 999 },
      }),
      config,
    );
    expect(forwardedBody(fetchSpy).params.parameters.fee_mode).toEqual({
      mode: "sponsored",
      tip: 10,
    });
  });

  // --- C2/H6: fail-closed durable rate limit + global budget cap ---

  it("fails closed when rateLimit is set with the in-memory store and no allowInMemoryStore", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const config = makeConfig({
      policy: { ...policy, allowInMemoryStore: false },
      store: new InMemoryRateLimitStore(),
    });
    const { body } = await handlePaymasterRequest(
      buildReq([{ to: TARGET, selector: SELECTOR }]),
      config,
    );
    expect(asRpc(body).error).toBeDefined();
    expect(asRpc(body).error!.message).toMatch(/durable store/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("global cap denies past maxPerWindow across different addresses", async () => {
    okFetch();
    const config = makeConfig({
      store: new InMemoryRateLimitStore(),
      policy: {
        ...policy,
        rateLimit: undefined,
        globalCap: { maxPerWindow: 2, windowSec: 60 },
        allowInMemoryStore: true,
      },
    });
    // Different addresses each time — only the global counter binds.
    expect(
      asRpc(
        (
          await handlePaymasterRequest(
            executeReq([{ To: TARGET, Selector: SELECTOR }], "0xa"),
            config,
          )
        ).body,
      ),
    ).not.toHaveProperty("error");
    expect(
      asRpc(
        (
          await handlePaymasterRequest(
            executeReq([{ To: TARGET, Selector: SELECTOR }], "0xb"),
            config,
          )
        ).body,
      ),
    ).not.toHaveProperty("error");
    const third = asRpc(
      (
        await handlePaymasterRequest(
          executeReq([{ To: TARGET, Selector: SELECTOR }], "0xc"),
          config,
        )
      ).body,
    );
    expect(third.error!.message).toMatch(/Global sponsorship budget/);
  });

  it("per-account denials do NOT erode the shared global budget counter", async () => {
    okFetch();
    // maxPerAddress 1, globalCap 2. Same address hits the per-account limit on its
    // second request; that denial must NOT consume a global slot (per-account is
    // checked before the global cap). A later first request from a fresh address
    // must therefore still succeed (global is at 1, not exhausted by the denials).
    const config = makeConfig({
      store: new InMemoryRateLimitStore(),
      policy: {
        ...policy,
        rateLimit: { maxPerAddress: 1, windowSec: 60 },
        globalCap: { maxPerWindow: 2, windowSec: 60 },
        allowInMemoryStore: true,
      },
    });
    const reqFrom = (addr: string) =>
      handlePaymasterRequest(executeReq([{ To: TARGET, Selector: SELECTOR }], addr), config);

    // 0xa: first request ok (per-account 1, global 1).
    expect(asRpc((await reqFrom("0xa")).body)).not.toHaveProperty("error");
    // 0xa again: per-account denied (2 > 1) — must short-circuit before global.
    const denied = asRpc((await reqFrom("0xa")).body);
    expect(denied.error!.message).toMatch(/Rate limit/);
    // 0xa again: still per-account denied; global must remain untouched.
    expect(asRpc((await reqFrom("0xa")).body).error!.message).toMatch(/Rate limit/);
    // Fresh address 0xb: global is only at 1, so this must succeed (count -> 2).
    expect(asRpc((await reqFrom("0xb")).body)).not.toHaveProperty("error");
  });

  it("a throwing store fails closed (request denied, upstream not called)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const throwingStore = {
      hit: async () => {
        throw new Error("redis unreachable");
      },
    };
    const config = makeConfig({
      store: throwingStore,
      policy: { ...policy, allowInMemoryStore: true },
    });
    const { body } = await handlePaymasterRequest(
      buildReq([{ to: TARGET, selector: SELECTOR }]),
      config,
    );
    expect(asRpc(body).error).toBeDefined();
    expect(asRpc(body).error!.message).toMatch(/store unavailable/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // --- M7: malformed felt -> INVALID_PARAMS, never a throw/500 ---

  it("malformed felt in a call yields INVALID_PARAMS (-32602), not a throw", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { body } = await handlePaymasterRequest(
      buildReq([{ to: "0xZZ", selector: SELECTOR }]),
      makeConfig(),
    );
    expect(asRpc(body).error!.code).toBe(-32602);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a present-but-unparseable felt ('0x') yields INVALID_PARAMS (-32602)", async () => {
    const { body } = await handlePaymasterRequest(
      buildReq([{ to: "0x", selector: SELECTOR }]),
      makeConfig(),
    );
    expect(asRpc(body).error!.code).toBe(-32602);
  });

  it("does NOT forward a signed V2 call shadowed by unsigned lowercase fields", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const req = executeReq([{ To: "0xdead", Selector: SELECTOR }]);
    const call = req.params.transaction.invoke.typed_data.message.Calls[0]!;
    Object.assign(call, { to: TARGET, selector: SELECTOR });
    const { body } = await handlePaymasterRequest(req, makeConfig());
    expect(asRpc(body).error!.message).toMatch(/not allowlisted/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "both `Calls` and `calls`",
      typed_data: {
        domain: { version: "1" },
        message: {
          calls: [{ to: "0xdead", selector: SELECTOR }],
          Calls: [{ To: TARGET, Selector: SELECTOR }],
        },
      },
      error: /carries both `Calls` \(V2\) and `calls` \(V1\)/,
    },
    {
      label: "no signed domain",
      typed_data: { message: { Calls: [{ To: TARGET, Selector: SELECTOR }] } },
      error: /unrecognized OutsideExecution typed-data domain/,
    },
  ])("rejects an execute with $label as INVALID_PARAMS", async ({ typed_data, error }) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const req = executeReq([]);
    req.params.transaction.invoke.typed_data = typed_data as never;
    const { body } = await handlePaymasterRequest(req, makeConfig());
    expect(asRpc(body).error!.code).toBe(-32602);
    expect(asRpc(body).error!.message).toMatch(error);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards a sponsored deploy-only executeTransaction", async () => {
    const fetchSpy = okFetch();
    const req = {
      jsonrpc: "2.0",
      id: 1,
      method: "paymaster_executeTransaction",
      params: {
        transaction: { type: "deploy", deployment: { address: "0xabc", class_hash: "0x1" } },
      },
    };
    const { body } = await handlePaymasterRequest(
      req,
      makeConfig({ policy: { ...policy, sponsoredClassHashes: ["0x1"] } }),
    );
    expect(asRpc(body)).not.toHaveProperty("error");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("forwards a signed deploy_and_invoke executeTransaction", async () => {
    const fetchSpy = okFetch();
    const req = executeReq([{ To: TARGET, Selector: SELECTOR }], "0xabc");
    const transaction = req.params.transaction as Record<string, unknown>;
    transaction.type = "deploy_and_invoke";
    transaction.deployment = { address: "0xabc", class_hash: "0x1" };
    const { body } = await handlePaymasterRequest(
      req,
      makeConfig({ policy: { ...policy, sponsoredClassHashes: ["0x1"] } }),
    );
    expect(asRpc(body)).not.toHaveProperty("error");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it.each([{}, "abc", 5])("rejects a build invoke.calls of %j as INVALID_PARAMS", async (calls) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const req = buildReq([]);
    (req.params.transaction.invoke as { calls: unknown }).calls = calls;
    const { body } = await handlePaymasterRequest(req, makeConfig());
    expect(asRpc(body).error!.code).toBe(-32602);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns POLICY_DENIED for an unsupported transaction type", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const req = executeReq([]);
    (req.params.transaction as { type: string }).type = "apply_action";
    const { body } = await handlePaymasterRequest(req, makeConfig());
    expect(asRpc(body).error!.code).toBe(-32010);
    expect(asRpc(body).error!.message).toMatch(/unsupported transaction type/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a request with no account address as INVALID_PARAMS before counting it", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const store = new InMemoryRateLimitStore();
    const hitSpy = vi.spyOn(store, "hit");
    const req = executeReq([{ To: TARGET, Selector: SELECTOR }]);
    delete (req.params.transaction.invoke as { user_address?: string }).user_address;
    const { body } = await handlePaymasterRequest(
      req,
      makeConfig({
        store,
        policy: { ...policy, globalCap: { maxPerWindow: 10, windowSec: 60 } },
      }),
    );
    expect(asRpc(body).error!.code).toBe(-32602);
    expect(asRpc(body).error!.message).toMatch(/no account address/);
    expect(hitSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards a request with no account address when only globalCap is set", async () => {
    const fetchSpy = okFetch();
    const req = executeReq([{ To: TARGET, Selector: SELECTOR }]);
    delete (req.params.transaction.invoke as { user_address?: string }).user_address;
    const globalCapOnly = {
      ...policy,
      rateLimit: undefined,
      globalCap: { maxPerWindow: 10, windowSec: 60 },
    };
    const { body } = await handlePaymasterRequest(req, makeConfig({ policy: globalCapOnly }));
    expect(asRpc(body)).not.toHaveProperty("error");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("rejects a deploy_and_invoke whose user_address and deployment.address differ", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const req = {
      jsonrpc: "2.0",
      id: 1,
      method: "paymaster_buildTransaction",
      params: {
        transaction: {
          type: "deploy_and_invoke",
          deployment: { address: "0xabc", class_hash: "0x1" },
          invoke: { user_address: "0x999", calls: [{ to: TARGET, selector: SELECTOR }] },
        },
      },
    };
    const { body } = await handlePaymasterRequest(
      req,
      makeConfig({ policy: { ...policy, sponsoredClassHashes: ["0x1"] } }),
    );
    expect(asRpc(body).error!.code).toBe(-32602);
    expect(asRpc(body).error!.message).toMatch(/conflicting account address/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
