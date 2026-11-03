// Runtime-agnostic fetch-style adapter for the paymaster proxy.
//
// Unlike the Vercel (filesystem-routed function) and Cloudflare (wrangler entry
// point) adapters, this one exposes a factory that returns a standard Web
// `(request: Request) => Promise<Response>` handler, so ANY fetch-based runtime
// can mount it directly:
//
//   - Hono (Cloud Run / Node 20+):  app.all("/paymaster", (c) => handler(c.req.raw))
//   - Bun:                          Bun.serve({ fetch: handler })
//   - Deno / plain Web server:      export default { fetch: handler }
//
// Rate limiting: `configFromEnv` auto-wires a durable `RedisRateLimitStore` when
// `UPSTASH_REDIS_REST_URL`/`_TOKEN` are set. If a rate limit / global cap is
// configured WITHOUT a durable store, `configFromEnv` THROWS (fail closed) unless
// `policy.allowInMemoryStore` is set, so the handler returns a 500 rather than
// silently un-limiting across instances.

import { configFromEnv, type ProxyEnv } from "../../src/config.js";
import { assertCoreDeployClassHashSponsored } from "../../src/core-guard.js";
import { handleFetchRequest } from "../../src/fetch-adapter.js";
import type { ProxyConfig } from "../../src/handler.js";

// Re-exported so consumers importing from the `@starkware-libs/anystark-paymaster-proxy/node`
// subpath can type an explicit env (e.g. `Deno.env.toObject() as ProxyEnv`).
export type { ProxyEnv } from "../../src/config.js";

/**
 * Build a fetch-style paymaster proxy handler.
 *
 * Each returned handler owns its own config: `configFromEnv(env)` is parsed
 * lazily on the first request and memoized for the life of THAT handler, so two
 * handlers built with different envs never share config (their sponsorship key /
 * policy / budget stay isolated).
 *
 * @param env Environment carrying `PAYMASTER_API_KEY`, `PAYMASTER_POLICY`, and
 *   the optional `PAYMASTER_UPSTREAM_URL` / Upstash vars. Defaults to
 *   `process.env`, which only works on runtimes that expose it (Node, Bun, Cloud
 *   Run). On runtimes without a `process` global (e.g. Deno) pass an explicit
 *   env object; when `process` is absent and none is passed, `configFromEnv`
 *   fails into the deliberate 500 rather than a raw ReferenceError.
 */
export function createPaymasterProxyHandler(
  env: ProxyEnv = (typeof process !== "undefined" ? process.env : undefined) as ProxyEnv,
): (request: Request) => Promise<Response> {
  // Per-instance memo: parse config and assert core/policy version-compatibility
  // once, then reuse the result (configFromEnv re-parses PAYMASTER_POLICY and rebuilds
  // the Redis store, and the version-skew guard re-derives the core-pinned hashes,
  // none of which we want to repeat per request), without leaking one instance's
  // config to another. The guard runs here at bootstrap; a skew fails closed as the
  // generic 500. `config` is set only after both succeed, so a failure retries next
  // request rather than caching a half-built config.
  let config: ProxyConfig | undefined;
  const getConfig = (): ProxyConfig => {
    if (config === undefined) {
      const resolved = configFromEnv(env);
      assertCoreDeployClassHashSponsored(resolved.policy);
      config = resolved;
    }
    return config;
  };

  return (request: Request): Promise<Response> => handleFetchRequest(request, getConfig);
}
