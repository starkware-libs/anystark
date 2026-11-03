import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProxyConfig } from "../src/handler.js";
import type { RpcErrorBody } from "./rpc-types.js";

// UNIT tests for the shared fetch pipeline at ITS OWN interface:
// handleFetchRequest(request, getConfig). The handler is mocked so these
// exercise only handleFetchRequest's branching (method gate, config-throw 500,
// RAW body pass-through, policy-denial passthrough, runtime-error 500, body-read
// 500) against real Node 20 Request/Response globals. The per-adapter config
// memoization / per-instance behavior lives in the node/cloudflare factory
// tests, NOT here, so this file complements those without duplicating them.

// vi.hoisted keeps ONE stable mock instance that the (hoisted) vi.mock factory
// returns, so the static handleFetchRequest import binds to the mocked handler.
const { handlePaymasterRequestMock } = vi.hoisted(() => ({
  handlePaymasterRequestMock: vi.fn(),
}));

vi.mock("../src/handler.js", () => ({ handlePaymasterRequest: handlePaymasterRequestMock }));
// The core version-skew guard runs inside the caller's getConfig (at adapter bootstrap), not
// in handleFetchRequest, so a getConfig that throws stands in for a skew here; the per-adapter
// factory tests (node/cloudflare/vercel) drive the guard's failure path through getConfig.

import {
  handleFetchRequest,
  METHOD_NOT_ALLOWED_BODY,
  NOT_CONFIGURED_BODY,
  INTERNAL_ERROR_BODY,
} from "../src/fetch-adapter.js";

const REQUEST_URL = "https://proxy.example/paymaster";

function postRequest(body: string): Request {
  return new Request(REQUEST_URL, { method: "POST", body });
}

// Minimal config: the handler is mocked, so the contents are irrelevant beyond
// satisfying the ProxyConfig type. getConfig is a thunk, mirroring the real API.
const fakeConfig = {} as ProxyConfig;
const getFakeConfig = () => fakeConfig;

// Narrow a parsed JSON-RPC error body without reaching for `any`.
const asRpc = async (response: Response) => (await response.json()) as RpcErrorBody;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handleFetchRequest", () => {
  it("rejects a non-POST request with a 405 Response carrying Allow + JSON content type and the -32600 body", async () => {
    const response = await handleFetchRequest(
      new Request(REQUEST_URL, { method: "GET" }),
      getFakeConfig,
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(await response.json()).toEqual(METHOD_NOT_ALLOWED_BODY);
    expect(handlePaymasterRequestMock).not.toHaveBeenCalled();
  });

  it("returns a generic 500 (NOT_CONFIGURED_BODY) and never calls the handler when getConfig throws", async () => {
    const getConfig = () => {
      throw new Error("Missing PAYMASTER_API_KEY: super-secret-key-do-not-leak");
    };

    const response = await handleFetchRequest(postRequest("{}"), getConfig);

    expect(response.status).toBe(500);
    const body = await asRpc(response);
    expect(body).toEqual(NOT_CONFIGURED_BODY);
    expect(JSON.stringify(body)).not.toContain("super-secret-key-do-not-leak");
    expect(handlePaymasterRequestMock).not.toHaveBeenCalled();
  });

  it("passes the RAW request body string (unparsed) to the handler and maps its status/body onto the Response", async () => {
    handlePaymasterRequestMock.mockResolvedValue({ status: 201, body: { ok: true } });
    const rawBody = '{"jsonrpc":"2.0","id":1,"method":"paymaster_isAvailable"}';

    const response = await handleFetchRequest(postRequest(rawBody), getFakeConfig);

    // Handler must receive the raw string verbatim, NOT a parsed object.
    expect(handlePaymasterRequestMock).toHaveBeenCalledWith(rawBody, fakeConfig);
    expect(response.status).toBe(201);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(await response.json()).toEqual({ ok: true });
  });

  it("forwards a core policy-denial result (200 + JSON-RPC error body) unchanged, not coerced to an error status", async () => {
    const denialBody = {
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32010, message: "Sponsorship denied: not allowed by policy" },
    };
    handlePaymasterRequestMock.mockResolvedValue({ status: 200, body: denialBody });

    const response = await handleFetchRequest(
      postRequest('{"jsonrpc":"2.0","id":7,"method":"paymaster_executeTransaction"}'),
      getFakeConfig,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(denialBody);
  });

  it("returns a generic 500 (INTERNAL_ERROR_BODY) without leaking the thrown message when the handler rejects", async () => {
    handlePaymasterRequestMock.mockRejectedValue(new Error("boom super-secret-key-do-not-leak"));

    const response = await handleFetchRequest(
      postRequest('{"jsonrpc":"2.0","id":1,"method":"paymaster_isAvailable"}'),
      getFakeConfig,
    );

    expect(response.status).toBe(500);
    const body = await asRpc(response);
    expect(body).toEqual(INTERNAL_ERROR_BODY);
    expect(JSON.stringify(body)).not.toContain("super-secret-key-do-not-leak");
  });

  it("maps a body-read failure to the same caught 500 (INTERNAL_ERROR_BODY) and never calls the handler", async () => {
    const request = postRequest("{}");
    vi.spyOn(request, "text").mockRejectedValue(new Error("stream read failed"));

    const response = await handleFetchRequest(request, getFakeConfig);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual(INTERNAL_ERROR_BODY);
    expect(handlePaymasterRequestMock).not.toHaveBeenCalled();
  });
});
