import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProxyEnv } from "../src/config.js";
import type { ProxyConfig } from "../src/handler.js";
import type { RpcErrorBody } from "./rpc-types.js";

// GLUE tests: handler and config are mocked so these exercise only the Worker's
// plumbing (method gate, misconfig 500, RAW body pass-through, config memoization)
// against real Node 20 Request/Response globals, NOT handler/config logic.

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
// The core version-skew guard runs at the worker bootstrap; mock it to a no-op so these glue
// tests exercise only the Worker plumbing, with one case below driving its failure path.
vi.mock("../src/core-guard.js", () => ({
  assertCoreDeployClassHashSponsored: assertCoreDeployClassHashSponsoredMock,
}));

type Worker = { fetch(request: Request, env: ProxyEnv): Promise<Response> };

// Fresh module (fresh memoized config) + the real worker, cast to a callable shape.
async function loadWorker(): Promise<Worker> {
  const module = await import("../adapters/cloudflare/worker.js");
  return module.default as unknown as Worker;
}

const WORKER_URL = "https://worker.example/";

function postRequest(body: string): Request {
  return new Request(WORKER_URL, { method: "POST", body });
}

// Narrow a parsed JSON-RPC error body without reaching for `any`.
const asRpc = async (response: Response) => (await response.json()) as RpcErrorBody;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("cloudflare paymaster adapter", () => {
  it("rejects a non-POST request with a 405 Response carrying Allow + JSON content type and -32600", async () => {
    const worker = await loadWorker();

    const response = await worker.fetch(new Request(WORKER_URL, { method: "GET" }), {} as ProxyEnv);

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
    expect(response.headers.get("Content-Type")).toBe("application/json");
    const body = await asRpc(response);
    expect(body.error.code).toBe(-32600);
    expect(configFromEnvMock).not.toHaveBeenCalled();
    expect(handlePaymasterRequestMock).not.toHaveBeenCalled();
  });

  it("returns a generic 500 (-32603) with no secret material when config throws", async () => {
    configFromEnvMock.mockImplementation(() => {
      throw new Error("Missing PAYMASTER_API_KEY: super-secret-key-do-not-leak");
    });
    const worker = await loadWorker();

    const response = await worker.fetch(postRequest("{}"), {} as ProxyEnv);

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
    const worker = await loadWorker();

    const response = await worker.fetch(
      postRequest('{"jsonrpc":"2.0","id":1,"method":"paymaster_isAvailable"}'),
      {} as ProxyEnv,
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
    const worker = await loadWorker();

    const response = await worker.fetch(postRequest("{}"), {} as ProxyEnv);

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

  it("passes the RAW request body string (unparsed) to the handler and maps its status/body/headers", async () => {
    const config = {} as ProxyConfig;
    configFromEnvMock.mockReturnValue(config);
    handlePaymasterRequestMock.mockResolvedValue({ status: 201, body: { ok: true } });
    const worker = await loadWorker();
    const rawBody = '{"jsonrpc":"2.0","id":1,"method":"paymaster_isAvailable"}';

    const response = await worker.fetch(postRequest(rawBody), {} as ProxyEnv);

    // Handler must receive the raw string verbatim, NOT a parsed object.
    expect(handlePaymasterRequestMock).toHaveBeenCalledWith(rawBody, config);
    expect(response.status).toBe(201);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(await response.json()).toEqual({ ok: true });
  });

  it("memoizes the first config even when a later request arrives with a different env (warm-isolate lock)", async () => {
    configFromEnvMock.mockReturnValue({} as ProxyConfig);
    handlePaymasterRequestMock.mockResolvedValue({ status: 200, body: {} });
    const worker = await loadWorker();
    const firstEnv = { PAYMASTER_API_KEY: "first" } as ProxyEnv;
    const secondEnv = { PAYMASTER_API_KEY: "second" } as ProxyEnv;

    await worker.fetch(postRequest("{}"), firstEnv);
    await worker.fetch(postRequest("{}"), secondEnv);

    expect(configFromEnvMock).toHaveBeenCalledOnce();
    // The one build used the FIRST env; the differing second env was ignored.
    expect(configFromEnvMock).toHaveBeenCalledWith(firstEnv);
  });
});
