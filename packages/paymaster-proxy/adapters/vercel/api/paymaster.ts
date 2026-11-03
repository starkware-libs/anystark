// Vercel serverless function adapter for the paymaster proxy.
//
// Set the Vercel project's Root Directory to
// `packages/paymaster-proxy/adapters/vercel` so Vercel's filesystem routing
// exposes this file at `/api/paymaster` (without that, the route 404s). Point
// the SDK's `PaymasterRpc({ nodeUrl })` at that URL.
//
// Rate limiting: `configFromEnv` auto-wires a durable `RedisRateLimitStore` when
// `UPSTASH_REDIS_REST_URL`/`_TOKEN` are set. If a rate limit / global cap is
// configured WITHOUT a durable store, `configFromEnv` THROWS (fail closed) unless
// `policy.allowInMemoryStore` is set — so this function returns a 500 rather than
// silently un-limiting across serverless invocations.

import { configFromEnv } from "../../../src/config.js";
import { assertCoreDeployClassHashSponsored } from "../../../src/core-guard.js";
import {
  INTERNAL_ERROR_BODY,
  METHOD_NOT_ALLOWED_BODY,
  NOT_CONFIGURED_BODY,
} from "../../../src/fetch-adapter.js";
import { handlePaymasterRequest } from "../../../src/handler.js";

// Minimal structural types so this compiles without @vercel/node installed.
interface VercelRequest {
  method?: string;
  body?: unknown;
}
interface VercelResponse {
  status(code: number): VercelResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
}

// process.env is fixed at deploy and stable across invocations on a warm Vercel
// function, so parse the config and assert core/policy version-compatibility once,
// then reuse the result (configFromEnv re-parses PAYMASTER_POLICY and rebuilds the
// Redis store, and the version-skew guard re-derives the core-pinned hashes, which we
// don't want per request). The guard runs here at bootstrap; a skew fails closed as
// the generic 500. `config` is set only after both succeed, so a failure retries.
let config: ReturnType<typeof configFromEnv> | undefined;
function getConfig(): ReturnType<typeof configFromEnv> {
  if (config === undefined) {
    const resolved = configFromEnv(process.env as Record<string, string | undefined>);
    assertCoreDeployClassHashSponsored(resolved.policy);
    config = resolved;
  }
  return config;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json(METHOD_NOT_ALLOWED_BODY);
    return;
  }

  let cfg;
  try {
    cfg = getConfig();
  } catch {
    // Misconfiguration (including a policy/core version skew caught by getConfig at
    // bootstrap): do not echo details that might include secrets.
    res.status(500).json(NOT_CONFIGURED_BODY);
    return;
  }

  try {
    // Vercel parses JSON bodies into objects; handlePaymasterRequest accepts both.
    const { status, body } = await handlePaymasterRequest((req.body ?? "") as string | object, cfg);
    res.status(status).json(body);
  } catch {
    // Runtime failure (body read / unexpected handler rejection): never leak the
    // thrown message/stack, env, key, or upstream URL to the caller. Without this
    // the rejection would escape to Vercel's platform 500 (which can leak a stack),
    // diverging from the node/cloudflare adapters' clean generic 500.
    res.status(500).json(INTERNAL_ERROR_BODY);
  }
}
