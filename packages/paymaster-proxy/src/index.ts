// Public API of @starkware-libs/anystark-paymaster-proxy.

export {
  normalizeFelt,
  checkBuildTransaction,
  checkExecuteTransaction,
  checkTransaction,
  extractTargets,
  hasLimit,
  InvalidFeltError,
  InvalidOutsideExecutionError,
  ConflictingAccountAddressError,
  type AllowedCall,
  type FeeMode,
  type SponsorshipPolicy,
  type PolicyDecision,
  type ExtractedTargets,
} from "./policy.js";

export {
  handlePaymasterRequest,
  InMemoryRateLimitStore,
  type RateLimitStore,
  type ProxyConfig,
} from "./handler.js";

export { RedisRateLimitStore, type UpstashEnv } from "./redis-store.js";

export { configFromEnv, type ProxyEnv } from "./config.js";

export { assertCoreDeployClassHashSponsored } from "./core-guard.js";
