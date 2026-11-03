// Shared glue for the fetch-style paymaster proxy adapters.
//
// The Node factory (adapters/node/handler.ts) and the Cloudflare worker
// (adapters/cloudflare/worker.ts) are structurally identical Web Fetch handlers
// (method gate -> getConfig -> forward -> jsonResponse); this module holds that
// single pipeline plus the canned JSON-RPC error bodies. The Vercel adapter is
// req/res-shaped rather than fetch-shaped, so it reuses only the body literals.

import { handlePaymasterRequest, type ProxyConfig } from "./handler.js";

// Canned JSON-RPC 2.0 error bodies, shared across all three adapters so the
// wire contract stays identical no matter where the proxy is deployed.

/** 405 body: the request used a method other than POST. */
export const METHOD_NOT_ALLOWED_BODY = {
  jsonrpc: "2.0",
  id: null,
  error: { code: -32600, message: "Method Not Allowed: use POST" },
} as const;

/** 500 body: configuration is missing/invalid (configFromEnv threw). */
export const NOT_CONFIGURED_BODY = {
  jsonrpc: "2.0",
  id: null,
  error: { code: -32603, message: "Paymaster proxy is not configured" },
} as const;

/**
 * 500 body: an unexpected runtime error while handling the request (body read,
 * upstream forward, etc.). Deliberately generic so no thrown message, stack, or
 * secret material can leak to the caller.
 */
export const INTERNAL_ERROR_BODY = {
  jsonrpc: "2.0",
  id: null,
  error: { code: -32603, message: "Internal error" },
} as const;

/** Serialize `body` as an `application/json` Response with an optional extra header set. */
function jsonResponse(
  status: number,
  body: object,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

/**
 * Shared fetch pipeline for the Node and Cloudflare adapters: reject non-POST
 * with 405, resolve the (memoized) config via `getConfig` returning a generic
 * 500 if it throws, then forward the raw body to `handlePaymasterRequest`.
 *
 * `getConfig` is supplied by the caller so each adapter owns its own memoization
 * scope (per-instance for the Node factory, per-warm-isolate for the worker). It
 * also runs the core/policy version-skew guard once at that bootstrap, so a skew
 * surfaces here as the same generic 500 as any other misconfiguration. Any throw
 * from the request-handling body (body read / handler) is caught and mapped to a
 * generic INTERNAL_ERROR 500 so no error message or stack leaks.
 */
export async function handleFetchRequest(
  request: Request,
  getConfig: () => ProxyConfig,
): Promise<Response> {
  if (request.method !== "POST") {
    // RFC 7231 requires an Allow header on 405.
    return jsonResponse(405, METHOD_NOT_ALLOWED_BODY, { Allow: "POST" });
  }

  let config: ProxyConfig;
  try {
    config = getConfig();
  } catch {
    // Misconfiguration (including a policy/core version skew caught by getConfig at
    // bootstrap): do not echo details that might include secrets.
    return jsonResponse(500, NOT_CONFIGURED_BODY);
  }

  try {
    const rawBody = await request.text();
    const { status, body } = await handlePaymasterRequest(rawBody, config);
    return jsonResponse(status, body);
  } catch {
    // Runtime failure (e.g. body read or an unexpected handler rejection): never
    // leak the thrown message/stack, env, key, or upstream URL to the caller.
    return jsonResponse(500, INTERNAL_ERROR_BODY);
  }
}
