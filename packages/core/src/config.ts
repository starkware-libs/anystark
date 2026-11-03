// ─── Connector configuration ───
// The SDK takes all network/contract config by INJECTION (no import.meta.env,
// no hardcoded RPC). The using app passes a PhantomConnectorConfig and is
// responsible for sourcing these values (e.g. from its own build env).

import type { SigningLabel } from "./signer";

/** Starknet chain IDs (the `chainId` felt as returned by starknet.js / RPC). */
export const CHAIN_IDS = {
  /** SN_SEPOLIA */
  sepolia: "0x534e5f5345504f4c4941",
  /** SN_MAIN */
  mainnet: "0x534e5f4d41494e",
} as const;

export type ChainId = (typeof CHAIN_IDS)[keyof typeof CHAIN_IDS] | (string & {});

export interface PhantomConnectorConfig {
  /** Starknet JSON-RPC URL the derived account talks to. */
  starknetRpcUrl: string;
  /** Starknet chain id (see CHAIN_IDS); used to resolve the sol_account class hash. */
  chainId?: ChainId;
  /** SNIP-29 paymaster (REQUIRED): the connected account always executes sponsored
   *  (service-paid) transactions through it. */
  paymaster: PaymasterConfig;
  /** Optional human-readable label placed before the base64 hash in every signed
   *  message, separated from it by a single `\n`, so the wallet popup shows the user
   *  what they approve. Default none (cheapest, single
   *  SHA-512 block). Keep it a succinct sentence: an over-long label (> 258 UTF-8 bytes)
   *  is rejected before signing, and each extra SHA-512 block costs ~5.3M gas on every
   *  validation.
   *
   *  A `string` labels every signature identically. A `LabeledExecutor` labels each
   *  action separately (e.g. "buy X for Y USDC"): its `execute()` sets a one-shot label
   *  the signer consumes at sign time, and its calls are serialized so a label can
   *  never attach to another call's signature. Pass the instance here and route the
   *  app's actions through its `execute()`; see its class doc for the lifecycle and the
   *  invariant it requires. `undefined` or `''` yields the bare hash, no label.
   *
   *  Both forms are validated identically and both are ADVISORY: the chain verifies
   *  only the hash, never the text. */
  signingLabel?: SigningLabel;
}

/**
 * Who pays gas under SNIP-29. Mirrors starknet.js's `FeeMode` and extends the
 * `default` variant with a caller-side `maxFeeInGasToken` ceiling: starknet.js
 * only binds the paymaster's appended repayment amount when such a ceiling is
 * supplied, so we require it here and enforce it in the signing guard (see
 * assertTypedDataMatchesRequest in account.ts). Declared standalone so config.ts
 * stays free of a starknet import; keep in lockstep with starknet's `FeeMode`.
 */
export type PaymasterFeeMode =
  | { mode: "sponsored" }
  | { mode: "default"; gasToken: string; maxFeeInGasToken: bigint };

/**
 * SNIP-29 paymaster service configuration. It is always present on the account, so
 * every `execute()` routes through the paymaster: the wallet signs a SNIP-9 outside
 * execution and the service submits and pays for the actual transaction. The
 * paymaster funds execution on the account's behalf, and even sponsors the
 * first-use counterfactual deployment.
 */
export interface PaymasterConfig {
  /** Paymaster JSON-RPC URL (the SNIP-29 `paymaster_*` namespace). */
  nodeUrl: string;
  /** Extra HTTP headers sent with every paymaster request (e.g. an API key). */
  headers?: Record<string, string>;
  /**
   * Who pays the gas. `sponsored`: the service pays (requires a sponsorship deal).
   * `default`: the account repays the service in `gasToken` via a transfer call the
   * paymaster appends; `maxFeeInGasToken` caps that repayment — the signing guard
   * rejects a quote (or an appended amount) above it. Defaults to `sponsored`.
   */
  feeMode?: PaymasterFeeMode;
}
