import { describe, it, expect, vi, afterEach } from "vitest";
import { RedisRateLimitStore } from "../src/redis-store.js";

const URL = "https://example.upstash.io";
const TOKEN = "upstash-token-123";

// Mock globalThis.fetch to return the given pipeline JSON (array of {result|error})
// with the given HTTP status; capture the request for assertions.
function mockFetch(body: unknown, status = 200) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RedisRateLimitStore", () => {
  it("rejects construction without url/token", () => {
    expect(() => new RedisRateLimitStore("", TOKEN)).toThrow();
    expect(() => new RedisRateLimitStore(URL, "")).toThrow();
  });

  it("fromEnv returns undefined when either var is missing, a store when both present", () => {
    expect(RedisRateLimitStore.fromEnv({})).toBeUndefined();
    expect(RedisRateLimitStore.fromEnv({ UPSTASH_REDIS_REST_URL: URL })).toBeUndefined();
    expect(RedisRateLimitStore.fromEnv({ UPSTASH_REDIS_REST_TOKEN: TOKEN })).toBeUndefined();
    const store = RedisRateLimitStore.fromEnv({
      UPSTASH_REDIS_REST_URL: URL,
      UPSTASH_REDIS_REST_TOKEN: TOKEN,
    });
    expect(store).toBeInstanceOf(RedisRateLimitStore);
  });

  it("sends an INCR+EXPIRE pipeline with auth header and pmx:rl: namespacing", async () => {
    const spy = mockFetch([{ result: 1 }, { result: 1 }]);
    const store = new RedisRateLimitStore(URL, TOKEN);
    const count = await store.hit("0xabc", 60);

    expect(count).toBe(1);
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe(`${URL}/pipeline`);
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent).toEqual([
      ["INCR", "pmx:rl:0xabc"],
      ["EXPIRE", "pmx:rl:0xabc", "60", "NX"],
    ]);
  });

  it("returns the INCR count on subsequent hits (EXPIRE not required after creation)", async () => {
    // count !== 1 means the key already existed; EXPIRE result 0 (no-op) is fine.
    mockFetch([{ result: 5 }, { result: 0 }]);
    const store = new RedisRateLimitStore(URL, TOKEN);
    expect(await store.hit("k", 60)).toBe(5);
  });

  it("fails closed on a non-OK HTTP status", async () => {
    mockFetch([{ result: 1 }, { result: 1 }], 500);
    const store = new RedisRateLimitStore(URL, TOKEN);
    await expect(store.hit("k", 60)).rejects.toThrow(/HTTP 500/);
  });

  it("fails closed on an empty/non-array response", async () => {
    mockFetch({});
    const store = new RedisRateLimitStore(URL, TOKEN);
    await expect(store.hit("k", 60)).rejects.toThrow(/unexpected response/);
  });

  it("fails closed when INCR reports an error", async () => {
    mockFetch([{ error: "WRONGTYPE" }, { result: 1 }]);
    const store = new RedisRateLimitStore(URL, TOKEN);
    await expect(store.hit("k", 60)).rejects.toThrow(/INCR error/);
  });

  it("fails closed when INCR returns a non-numeric result", async () => {
    mockFetch([{ result: "not-a-number" }, { result: 1 }]);
    const store = new RedisRateLimitStore(URL, TOKEN);
    await expect(store.hit("k", 60)).rejects.toThrow(/non-numeric/);
  });

  it("fails closed when EXPIRE reports an error", async () => {
    mockFetch([{ result: 1 }, { error: "ERR syntax" }]);
    const store = new RedisRateLimitStore(URL, TOKEN);
    await expect(store.hit("k", 60)).rejects.toThrow(/EXPIRE error/);
  });

  it("fails closed when a newly created key did NOT get a TTL (EXPIRE result 0)", async () => {
    // INCR returned 1 (key just created) but EXPIRE NX returned 0 => no TTL set:
    // the counter would never reset. Must throw so the misconfig surfaces.
    mockFetch([{ result: 1 }, { result: 0 }]);
    const store = new RedisRateLimitStore(URL, TOKEN);
    await expect(store.hit("k", 60)).rejects.toThrow(/did not set a TTL/);
  });
});
