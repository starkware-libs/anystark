import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProxyConfig } from "../src/handler.js";
import type { RpcErrorBody } from "./rpc-types.js";

// GLUE tests: the handler and config are mocked so these only exercise the
// adapter's request/response plumbing (method gate, misconfig 500, body pass-through,
// config memoization), NOT handler/config logic (covered by handler/config tests).

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
// The core version-skew guard runs at the function bootstrap; mock it to a no-op so these
// glue tests exercise only the adapter plumbing, with one case below driving its failure path.
vi.mock("../src/core-guard.js", () => ({
  assertCoreDeployClassHashSponsored: assertCoreDeployClassHashSponsoredMock,
}));

// Captures what the adapter writes back, standing in for Vercel's res object.
interface CapturedResponse {
  statusCode?: number;
  jsonBody?: unknown;
  headers: Record<string, string>;
  status(code: number): CapturedResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
}

function makeCapturedResponse(): CapturedResponse {
  return {
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.jsonBody = body;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
  };
}

type VercelHandler = (
  req: { method?: string; body?: unknown },
  res: CapturedResponse,
) => Promise<void>;

// Fresh module (fresh memoized config) + the real adapter, cast to a callable shape.
async function loadHandler(): Promise<VercelHandler> {
  const module = await import("../adapters/vercel/api/paymaster.js");
  return module.default as unknown as VercelHandler;
}

const asRpc = (body: unknown) => body as RpcErrorBody;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("vercel paymaster adapter", () => {
  it("rejects a non-POST method with 405, an Allow: POST header, and -32600, touching neither config nor handler", async () => {
    const handler = await loadHandler();
    const res = makeCapturedResponse();

    await handler({ method: "GET" }, res);

    expect(res.statusCode).toBe(405);
    expect(res.headers["Allow"]).toBe("POST");
    expect(asRpc(res.jsonBody).error.code).toBe(-32600);
    expect(configFromEnvMock).not.toHaveBeenCalled();
    expect(handlePaymasterRequestMock).not.toHaveBeenCalled();
  });

  it("returns a generic 500 (-32603) with no secret material when config throws", async () => {
    configFromEnvMock.mockImplementation(() => {
      throw new Error("Missing PAYMASTER_API_KEY: super-secret-key-do-not-leak");
    });
    const handler = await loadHandler();
    const res = makeCapturedResponse();

    await handler({ method: "POST", body: {} }, res);

    expect(res.statusCode).toBe(500);
    expect(res.jsonBody).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: "Paymaster proxy is not configured" },
    });
    expect(JSON.stringify(res.jsonBody)).not.toContain("super-secret-key-do-not-leak");
    expect(handlePaymasterRequestMock).not.toHaveBeenCalled();
  });

  it("returns a generic 500 (-32603 'Internal error') without leaking the thrown message when the handler rejects", async () => {
    configFromEnvMock.mockReturnValue({} as ProxyConfig);
    handlePaymasterRequestMock.mockRejectedValue(new Error("boom super-secret-key-do-not-leak"));
    const handler = await loadHandler();
    const res = makeCapturedResponse();

    await handler({ method: "POST", body: { jsonrpc: "2.0", id: 1 } }, res);

    expect(res.statusCode).toBe(500);
    expect(res.jsonBody).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: "Internal error" },
    });
    expect(JSON.stringify(res.jsonBody)).not.toContain("super-secret-key-do-not-leak");
  });

  it("returns the generic misconfigured 500 (-32603) with no leak when the core version-skew guard throws", async () => {
    configFromEnvMock.mockReturnValue({} as ProxyConfig);
    assertCoreDeployClassHashSponsoredMock.mockImplementationOnce(() => {
      throw new Error("core pins 0xcore-hash-super-secret-do-not-leak");
    });
    const handler = await loadHandler();
    const res = makeCapturedResponse();

    await handler({ method: "POST", body: {} }, res);

    expect(res.statusCode).toBe(500);
    expect(res.jsonBody).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: "Paymaster proxy is not configured" },
    });
    expect(JSON.stringify(res.jsonBody)).not.toContain("super-secret-do-not-leak");
    expect(handlePaymasterRequestMock).not.toHaveBeenCalled();
  });

  it("forwards req.body verbatim to the handler and maps the handler's status/body onto res", async () => {
    const config = {} as ProxyConfig;
    configFromEnvMock.mockReturnValue(config);
    handlePaymasterRequestMock.mockResolvedValue({ status: 200, body: { x: 1 } });
    const handler = await loadHandler();
    const res = makeCapturedResponse();
    const body = { jsonrpc: "2.0", id: 1, method: "paymaster_isAvailable" };

    await handler({ method: "POST", body }, res);

    expect(handlePaymasterRequestMock).toHaveBeenCalledWith(body, config);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({ x: 1 });
  });

  it("passes an empty string to the handler when req.body is undefined", async () => {
    configFromEnvMock.mockReturnValue({} as ProxyConfig);
    handlePaymasterRequestMock.mockResolvedValue({ status: 200, body: {} });
    const handler = await loadHandler();

    await handler({ method: "POST" }, makeCapturedResponse());

    expect(handlePaymasterRequestMock).toHaveBeenCalledWith("", expect.anything());
  });

  it("memoizes the config across requests: configFromEnv runs exactly once for two POSTs", async () => {
    configFromEnvMock.mockReturnValue({} as ProxyConfig);
    handlePaymasterRequestMock.mockResolvedValue({ status: 200, body: {} });
    const handler = await loadHandler();

    await handler({ method: "POST", body: {} }, makeCapturedResponse());
    await handler({ method: "POST", body: {} }, makeCapturedResponse());

    expect(configFromEnvMock).toHaveBeenCalledOnce();
    expect(handlePaymasterRequestMock).toHaveBeenCalledTimes(2);
  });
});
