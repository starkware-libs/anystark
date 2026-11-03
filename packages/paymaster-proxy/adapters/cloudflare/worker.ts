// Cloudflare Worker adapter for the paymaster proxy.
//
// Deploy with `wrangler deploy`; point the SDK's `PaymasterRpc({ nodeUrl })` at
// the worker URL.
//
// Rate limiting: `configFromEnv` auto-wires a durable `RedisRateLimitStore` when
// `UPSTASH_REDIS_REST_URL`/`_TOKEN` are set. If a rate limit / global cap is
// configured WITHOUT a durable store, `configFromEnv` THROWS (fail closed) unless
// `policy.allowInMemoryStore` is set, so the worker returns a 500 rather than
// silently un-limiting across Worker isolates.

import { configFromEnv, type ProxyEnv } from "../../src/config.js";
import { assertCoreDeployClassHashSponsored } from "../../src/core-guard.js";
import { handleFetchRequest } from "../../src/fetch-adapter.js";
import type { ProxyConfig } from "../../src/handler.js";

// `env` is fixed at deploy and stable across requests on a warm isolate, so parse
// the config and assert core/policy version-compatibility once, then reuse the result
// (configFromEnv re-parses PAYMASTER_POLICY and rebuilds the Redis store, and the
// version-skew guard re-derives the core-pinned hashes, which we don't want to repeat
// per request). The guard runs here at bootstrap; a skew fails closed as the generic
// 500. `config` is set only after both succeed, so a failure retries the next request.
let config: ProxyConfig | undefined;
function getConfig(env: ProxyEnv): ProxyConfig {
  if (config === undefined) {
    const resolved = configFromEnv(env);
    assertCoreDeployClassHashSponsored(resolved.policy);
    config = resolved;
  }
  return config;
}

export default {
  async fetch(request: Request, env: ProxyEnv): Promise<Response> {
    return handleFetchRequest(request, () => getConfig(env));
  },
};
