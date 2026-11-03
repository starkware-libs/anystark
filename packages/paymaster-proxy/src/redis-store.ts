// Durable rate-limit store backed by Upstash Redis over its REST API.
//
// Uses only `fetch` (no new dependency). One sliding-window-ish counter per key
// implemented as INCR + EXPIRE: the first hit in a window creates the key with a
// TTL; subsequent hits increment it; the key self-expires after `windowSec`.
//
// This is the store that makes rate-limit + global-budget enforcement DURABLE
// across serverless/edge isolates. Construct it from env via `fromEnv`.

import type { RateLimitStore } from "./handler.js";

export interface UpstashEnv {
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
}

export class RedisRateLimitStore implements RateLimitStore {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {
    if (!url || !token) {
      throw new Error("RedisRateLimitStore requires a non-empty url and token");
    }
  }

  /**
   * Construct from `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`.
   * Returns `undefined` if either is missing, so callers can decide whether to
   * fall back (with `allowInMemoryStore`) or fail closed.
   */
  static fromEnv(env: UpstashEnv): RedisRateLimitStore | undefined {
    const url = env.UPSTASH_REDIS_REST_URL;
    const token = env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) return undefined;
    return new RedisRateLimitStore(url, token);
  }

  /**
   * Increment `key` and (on first creation) set its TTL to `windowSec`, in ONE
   * round trip via an Upstash pipeline. NOTE: `/pipeline` runs the commands
   * sequentially but is NOT transactional (no MULTI/EXEC isolation — that is
   * `/multi-exec`); "one round trip" is accurate, "atomic" is not. We compensate
   * by verifying the EXPIRE result below so a key can never survive without a TTL.
   *
   * Throws on any non-OK HTTP status or malformed response so the handler can
   * FAIL CLOSED (deny the request) rather than silently skip the limit.
   */
  async hit(key: string, windowSec: number): Promise<number> {
    // Namespaced so different proxies sharing a Redis don't collide.
    const k = `pmx:rl:${key}`;
    const res = await fetch(`${this.url}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([
        ["INCR", k],
        // NX: only set the TTL when it isn't already set (i.e. the first hit).
        ["EXPIRE", k, String(windowSec), "NX"],
      ]),
    });

    if (!res.ok) {
      throw new Error(`Upstash pipeline failed: HTTP ${res.status}`);
    }

    const json = (await res.json()) as Array<{ result?: unknown; error?: string }>;
    if (!Array.isArray(json) || json.length < 2) {
      throw new Error("Upstash pipeline returned an unexpected response");
    }
    const incr = json[0];
    if (incr.error) throw new Error(`Upstash INCR error: ${incr.error}`);
    const count = Number(incr.result);
    if (!Number.isFinite(count)) {
      throw new Error("Upstash INCR returned a non-numeric result");
    }

    // Inspect the EXPIRE result too. If INCR created the key (count === 1) the
    // EXPIRE NX must have set a TTL (result 1); a 0 (or any error) means the key
    // now has NO expiry and the counter would never reset — leaving the limit
    // permanently tripped. Fail closed so the misconfig surfaces immediately.
    const expire = json[1];
    if (expire.error) throw new Error(`Upstash EXPIRE error: ${expire.error}`);
    if (count === 1 && Number(expire.result) !== 1) {
      throw new Error("Upstash EXPIRE did not set a TTL on a newly created counter key");
    }

    return count;
  }
}
