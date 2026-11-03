import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ProxyEnv } from "../src/config.js";
import type { RpcErrorBody } from "./rpc-types.js";

// End-to-end, NO mocks: drive the REAL Cloudflare worker with the REAL config
// parser + handler. A PAYMASTER_POLICY whose allowedCalls list two entries with
// the same canonical address must be rejected when the config is first loaded, so
// the worker returns HTTP 500 and NEVER reaches the upstream paymaster. This closes
// the loop that enforcement is unreachable for a duplicate policy: the adapter GLUE
// tests mock configFromEnv, so they cannot catch a real parse-time rejection, and
// the direct policy/config unit tests never exercise the HTTP path. The Cloudflare
// worker is used because it takes `env` as a fetch() argument (no process.env), so a
// duplicate policy can be driven through the real handler with a single request.

const TARGET = "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7";
const SELECTOR = "0x0083afd3f4caedc6eebf44246fe54e38c95e3179a5ec9ea81740eca5b482d12e";

// Two entries for the SAME address (a selector-list entry plus a bare any-selector
// entry) — the broadening case configFromEnv must reject.
const DUPLICATE_POLICY = {
  allowedCalls: [{ to: TARGET, selectors: [SELECTOR] }, { to: TARGET }],
  sponsoredClassHashes: [] as string[],
};

function duplicatePolicyEnv(): ProxyEnv {
  return {
    PAYMASTER_API_KEY: "secret-key",
    PAYMASTER_POLICY: JSON.stringify(DUPLICATE_POLICY),
  };
}

const WORKER_URL = "https://worker.example/";

// A real paymaster_executeTransaction POST (the call that actually spends money):
// calls live in the signed SNIP-12 typed data with capitalized To/Selector.
const executeRequestBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "paymaster_executeTransaction",
  params: {
    transaction: {
      type: "invoke",
      invoke: {
        user_address: "0x1234",
        typed_data: {
          domain: { version: "2", revision: "1" },
          message: { Calls: [{ To: TARGET, Selector: SELECTOR }] },
        },
      },
    },
  },
});

type Worker = { fetch(request: Request, env: ProxyEnv): Promise<Response> };

// Fresh module (fresh memoized config) + the real, UNMOCKED worker.
async function loadWorker(): Promise<Worker> {
  const module = await import("../adapters/cloudflare/worker.js");
  return module.default as unknown as Worker;
}

const asRpc = async (response: Response) => (await response.json()) as RpcErrorBody;

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("duplicate policy end-to-end (real config + handler, no mocks)", () => {
  it("returns 500 and never forwards upstream for a paymaster_executeTransaction POST", async () => {
    // Fail the test if the handler ever forwards upstream: a duplicate policy must
    // be rejected before any fetch happens, so enforcement is provably unreachable.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("upstream fetch must not be called for a duplicate policy");
    });

    const worker = await loadWorker();
    const request = new Request(WORKER_URL, { method: "POST", body: executeRequestBody });
    const response = await worker.fetch(request, duplicatePolicyEnv());

    expect(response.status).toBe(500);
    const body = await asRpc(response);
    expect(body.error.code).toBe(-32603);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
