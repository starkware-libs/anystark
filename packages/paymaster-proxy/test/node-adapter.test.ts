import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProxyEnv } from "../src/config.js";
import type { ProxyConfig } from "../src/handler.js";
import type { RpcErrorBody } from "./rpc-types.js";

// GLUE tests: handler and config are mocked so these exercise only the fetch
// adapter's plumbing (method gate, misconfig 500, runtime-error 500, RAW body
// pass-through, per-instance config memoization) against real Node 20
// Request/Response globals, NOT handler/config logic (covered by their tests).

// vi.hoisted keeps ONE stable mock instance per dependency across vi.resetModules():
// the mock factory re-runs on each dynamic import but returns these same fns, so
// call-count assertions survive the per-test module reset.
const { configFromEnvMock, handlePaymasterRequestMock, assertCoreDeployClassHashSponsoredMock } =
  vi.hoisted(() => ({
    configFromEnvMock: vi.fn(),
    handlePaymasterRequestMock: vi.fn(),
    assertCoreDeployClassHashSponsoredMock: vi.fn(),
  }));

vi.mock("../src/config.js", () => ({ configFromEnv: configFromEnvMock }));
vi.mock("../src/handler.js", () => ({ handlePaymasterRequest: handlePaymasterRequestMock }));
// The core version-skew guard runs at the adapter bootstrap; mock it to a no-op so these
// glue tests exercise only the fetch plumbing, with one case below driving its failure path.
vi.mock("../src/core-guard.js", () => ({
  assertCoreDeployClassHashSponsored: assertCoreDeployClassHashSponsoredMock,
}));

type CreateHandler = (env?: ProxyEnv) => (request: Request) => Promise<Response>;

// Fresh module (fresh module-scoped state) + the real factory.
async function loadFactory(): Promise<CreateHandler> {
  const module = await import("../adapters/node/handler.js");
  return module.createPaymasterProxyHandler;
}

const HANDLER_URL = "https://proxy.example/paymaster";

function postRequest(body: string): Request {
  return new Request(HANDLER_URL, { method: "POST", body });
}

// Narrow a parsed JSON-RPC error body without reaching for `any`.
const asRpc = async (response: Response) => (await response.json()) as RpcErrorBody;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("node fetch paymaster adapter", () => {
  it("rejects a non-POST request with a 405 Response carrying Allow + JSON content type and the full -32600 body", async () => {
    const handler = (await loadFactory())({} as ProxyEnv);

    const response = await handler(new Request(HANDLER_URL, { method: "GET" }));

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(await asRpc(response)).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Method Not Allowed: use POST" },
    });
    expect(configFromEnvMock).not.toHaveBeenCalled();
    expect(handlePaymasterRequestMock).not.toHaveBeenCalled();
  });

  it("returns a generic 500 (-32603) with no secret material when config throws", async () => {
    configFromEnvMock.mockImplementation(() => {
      throw new Error("Missing PAYMASTER_API_KEY: super-secret-key-do-not-leak");
    });
    const handler = (await loadFactory())({} as ProxyEnv);

    const response = await handler(postRequest("{}"));

    expect(response.status).toBe(500);
    const body = await asRpc(response);
    expect(body).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: "Paymaster proxy is not configured" },
    });
    expect(JSON.stringify(body)).not.toContain("super-secret-key-do-not-leak");
    expect(handlePaymasterRequestMock).not.toHaveBeenCalled();
  });

  it("returns a generic 500 (-32603 'Internal error') without leaking the thrown message when the handler rejects", async () => {
    configFromEnvMock.mockReturnValue({} as ProxyConfig);
    handlePaymasterRequestMock.mockRejectedValue(new Error("boom super-secret-key-do-not-leak"));
    const handler = (await loadFactory())({} as ProxyEnv);

    const response = await handler(
      postRequest('{"jsonrpc":"2.0","id":1,"method":"paymaster_isAvailable"}'),
    );

    expect(response.status).toBe(500);
    const body = await asRpc(response);
    expect(body).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: "Internal error" },
    });
    expect(JSON.stringify(body)).not.toContain("super-secret-key-do-not-leak");
  });

  it("returns the generic misconfigured 500 (-32603) with no leak when the core version-skew guard throws", async () => {
    configFromEnvMock.mockReturnValue({} as ProxyConfig);
    assertCoreDeployClassHashSponsoredMock.mockImplementationOnce(() => {
      throw new Error("core pins 0xcore-hash-super-secret-do-not-leak");
    });
    const handler = (await loadFactory())({} as ProxyEnv);

    const response = await handler(postRequest("{}"));

    expect(response.status).toBe(500);
    const body = await asRpc(response);
    expect(body).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: "Paymaster proxy is not configured" },
    });
    expect(JSON.stringify(body)).not.toContain("super-secret-do-not-leak");
    expect(handlePaymasterRequestMock).not.toHaveBeenCalled();
  });

  it("passes the RAW request body string (unparsed) to the handler and writes its status/body onto the Response", async () => {
    const config = {} as ProxyConfig;
    configFromEnvMock.mockReturnValue(config);
    handlePaymasterRequestMock.mockResolvedValue({ status: 201, body: { ok: true } });
    const handler = (await loadFactory())({} as ProxyEnv);
    const rawBody = '{"jsonrpc":"2.0","id":1,"method":"paymaster_isAvailable"}';

    const response = await handler(postRequest(rawBody));

    // Handler must receive the raw string verbatim, NOT a parsed object.
    expect(handlePaymasterRequestMock).toHaveBeenCalledWith(rawBody, config);
    expect(response.status).toBe(201);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(await response.json()).toEqual({ ok: true });
  });

  it("forwards a core policy-denial result (200 + JSON-RPC error body) unchanged, not coerced to an error status", async () => {
    configFromEnvMock.mockReturnValue({} as ProxyConfig);
    const denialBody = {
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32010, message: "Sponsorship denied: not allowed by policy" },
    };
    handlePaymasterRequestMock.mockResolvedValue({ status: 200, body: denialBody });
    const handler = (await loadFactory())({} as ProxyEnv);

    const response = await handler(
      postRequest('{"jsonrpc":"2.0","id":7,"method":"paymaster_executeTransaction"}'),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(denialBody);
  });

  it("gives each factory instance its own config: configFromEnv runs once per instance with that instance's env", async () => {
    const firstConfig = { instance: "first" } as unknown as ProxyConfig;
    const secondConfig = { instance: "second" } as unknown as ProxyConfig;
    const firstEnv = { PAYMASTER_API_KEY: "first" } as ProxyEnv;
    const secondEnv = { PAYMASTER_API_KEY: "second" } as ProxyEnv;
    configFromEnvMock.mockImplementation((env: ProxyEnv) =>
      env === firstEnv ? firstConfig : secondConfig,
    );
    handlePaymasterRequestMock.mockResolvedValue({ status: 200, body: {} });
    const createPaymasterProxyHandler = await loadFactory();

    const firstHandler = createPaymasterProxyHandler(firstEnv);
    const secondHandler = createPaymasterProxyHandler(secondEnv);
    await firstHandler(postRequest("{}"));
    await secondHandler(postRequest("{}"));

    // Each instance parsed its OWN env exactly once; no cross-instance reuse.
    expect(configFromEnvMock).toHaveBeenCalledTimes(2);
    expect(configFromEnvMock).toHaveBeenCalledWith(firstEnv);
    expect(configFromEnvMock).toHaveBeenCalledWith(secondEnv);
    // Requests to each handler use their own instance's config.
    expect(handlePaymasterRequestMock).toHaveBeenNthCalledWith(1, "{}", firstConfig);
    expect(handlePaymasterRequestMock).toHaveBeenNthCalledWith(2, "{}", secondConfig);
  });

  it("memoizes config within a single instance: configFromEnv runs once across multiple requests", async () => {
    configFromEnvMock.mockReturnValue({} as ProxyConfig);
    handlePaymasterRequestMock.mockResolvedValue({ status: 200, body: {} });
    const handler = (await loadFactory())({ PAYMASTER_API_KEY: "only" } as ProxyEnv);

    await handler(postRequest("{}"));
    await handler(postRequest("{}"));

    expect(configFromEnvMock).toHaveBeenCalledOnce();
    expect(handlePaymasterRequestMock).toHaveBeenCalledTimes(2);
  });
});
