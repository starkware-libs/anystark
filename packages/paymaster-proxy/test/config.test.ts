import { describe, it, expect } from "vitest";
import { configFromEnv, type ProxyEnv } from "../src/config.js";
import { RedisRateLimitStore } from "../src/redis-store.js";

const TARGET = "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7";
const SELECTOR = "0x0083afd3f4caedc6eebf44246fe54e38c95e3179a5ec9ea81740eca5b482d12e";

const basePolicy = {
  allowedCalls: [{ to: TARGET, selectors: [SELECTOR] }],
  sponsoredClassHashes: [] as string[],
};

function env(overrides: Partial<ProxyEnv> = {}): ProxyEnv {
  return {
    PAYMASTER_API_KEY: "secret-key",
    PAYMASTER_POLICY: JSON.stringify(basePolicy),
    ...overrides,
  };
}

const REDIS = {
  UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "token",
};

describe("configFromEnv", () => {
  it("throws when PAYMASTER_API_KEY is missing", () => {
    expect(() => configFromEnv(env({ PAYMASTER_API_KEY: undefined }))).toThrow(/PAYMASTER_API_KEY/);
  });

  it("throws when PAYMASTER_POLICY is missing", () => {
    expect(() => configFromEnv(env({ PAYMASTER_POLICY: undefined }))).toThrow(/PAYMASTER_POLICY/);
  });

  it("throws when PAYMASTER_POLICY is not valid JSON", () => {
    expect(() => configFromEnv(env({ PAYMASTER_POLICY: "{not json" }))).toThrow(/valid JSON/);
  });

  it("throws when allowedCalls/sponsoredClassHashes are not arrays", () => {
    expect(() =>
      configFromEnv(env({ PAYMASTER_POLICY: JSON.stringify({ allowedCalls: {} }) })),
    ).toThrow(/allowedCalls\[\] and sponsoredClassHashes\[\]/);
  });

  it("throws when the policy contains a malformed felt (fails the deploy, not each request)", () => {
    const bad = { allowedCalls: [{ to: "0xZZ", selectors: [SELECTOR] }], sponsoredClassHashes: [] };
    expect(() => configFromEnv(env({ PAYMASTER_POLICY: JSON.stringify(bad) }))).toThrow(
      /malformed felt in allowedCalls\[0\]\.to/,
    );
  });

  // Pins the PRODUCTION WIRING: configFromEnv runs assertUniqueAllowedCallTargets so a
  // duplicate policy is rejected when the policy is first loaded. The message/logic
  // itself is pinned by the direct unit tests in policy.test.ts; this case guards only
  // that configFromEnv actually calls the guard (hence the apparent redundancy).
  it("throws when two allowedCalls entries share the same target (rejected when first loaded)", () => {
    const bad = {
      allowedCalls: [
        { to: TARGET, selectors: [SELECTOR] },
        { to: TARGET, selectors: ["0x1"] },
      ],
      sponsoredClassHashes: [],
    };
    expect(() => configFromEnv(env({ PAYMASTER_POLICY: JSON.stringify(bad) }))).toThrow(
      /duplicate allowedCalls entries for the same address/,
    );
  });

  it("throws on a malformed sponsored class hash", () => {
    const bad = { allowedCalls: [], sponsoredClassHashes: ["0xnothex"] };
    expect(() => configFromEnv(env({ PAYMASTER_POLICY: JSON.stringify(bad) }))).toThrow(
      /malformed felt in sponsoredClassHashes\[0\]/,
    );
  });

  it("builds a config with no store when no limit is configured", () => {
    const config = configFromEnv(env());
    expect(config.apiKey).toBe("secret-key");
    expect(config.store).toBeUndefined();
  });

  it("wires a durable RedisRateLimitStore when Upstash env is present", () => {
    const config = configFromEnv(env(REDIS));
    expect(config.store).toBeInstanceOf(RedisRateLimitStore);
  });

  it("FAILS CLOSED when a limit is configured but no durable store and no allowInMemoryStore", () => {
    const policy = { ...basePolicy, rateLimit: { maxPerAddress: 5, windowSec: 60 } };
    expect(() => configFromEnv(env({ PAYMASTER_POLICY: JSON.stringify(policy) }))).toThrow(
      /no durable store/,
    );
  });

  it("allowInMemoryStore escape hatch lets a configured limit start without a durable store", () => {
    const policy = {
      ...basePolicy,
      rateLimit: { maxPerAddress: 5, windowSec: 60 },
      allowInMemoryStore: true,
    };
    const config = configFromEnv(env({ PAYMASTER_POLICY: JSON.stringify(policy) }));
    expect(config.store).toBeUndefined();
  });

  it("uses the Upstash store even with a limit configured (no fail-closed)", () => {
    const policy = { ...basePolicy, globalCap: { maxPerWindow: 100, windowSec: 60 } };
    const config = configFromEnv(env({ ...REDIS, PAYMASTER_POLICY: JSON.stringify(policy) }));
    expect(config.store).toBeInstanceOf(RedisRateLimitStore);
  });
});
