// ─── CCTP configuration (injected) ───
// All addresses/URLs are injected (no import.meta.env, no globals). Ready-made
// testnet and mainnet configs are provided for convenience; a dapp can override
// any field. The address literals live in ./addresses.ts (a Solana-free
// subpath a consumer can import without pulling @solana/web3.js); this module
// assembles them with the RPC/attestation URLs into the full CctpConfig. Each
// config holds copies of the address sub-objects, so a dapp overriding a field
// on a config leaves the shared literals every other consumer reads intact.

import {
  CCTP_MAINNET_ADDRESSES,
  CCTP_TESTNET_ADDRESSES,
  type CctpSolanaAddresses,
  type CctpStarknetAddresses,
} from "./addresses";

export type CctpStarknetConfig = CctpStarknetAddresses;

export interface CctpSolanaConfig extends CctpSolanaAddresses {
  /** Solana JSON-RPC URL. */
  rpcUrl: string;
}

export interface CctpConfig {
  /** Starknet JSON-RPC URL (used by recovery scans + nonce checks). */
  starknetRpcUrl: string;
  /** Circle attestation API base URL. */
  attestationApi: string;
  starknet: CctpStarknetConfig;
  solana: CctpSolanaConfig;
}

/**
 * Testnet config: Solana devnet (domain 5) ↔ Starknet Sepolia (domain 25), Circle
 * sandbox attestation API. BETA — re-verify addresses against
 * https://developers.circle.com/cctp before relying on them.
 */
export const CCTP_TESTNET_CONFIG: CctpConfig = {
  starknetRpcUrl: "https://api.zan.top/public/starknet-sepolia",
  attestationApi: "https://iris-api-sandbox.circle.com",
  starknet: { ...CCTP_TESTNET_ADDRESSES.starknet },
  solana: { rpcUrl: "https://api.devnet.solana.com", ...CCTP_TESTNET_ADDRESSES.solana },
};

/**
 * Mainnet config: Solana mainnet-beta (domain 5) ↔ Starknet mainnet (domain 25),
 * Circle's production attestation API. Every value is transcribed from Circle's
 * published tables — see the per-field citations below. (mainnet-beta is Solana's
 * production mainnet; there is no separate non-beta mainnet.)
 *
 * ─── VERIFICATION STATUS ───
 *   [x] address-verified   Every address matches Circle's official docs (cited per
 *                          field). The Starknet trio additionally cross-checks against
 *                          the addresses a production consumer already bridges with.
 *   [x] existence-checked  Confirmed live on-chain, no funds required, by
 *                          `scripts/verify_mainnet.mjs --preflight`: the two Solana
 *                          programs exist and are executable, the USDC mint reports
 *                          6 decimals, all three Starknet contracts return a class
 *                          hash, Starknet USDC answers `balanceOf`/`decimals`, the
 *                          mainnet Anchor IDLs are fetchable, the production Iris API
 *                          answers on `/v2/messages/{domain}`, and Circle's live fee
 *                          schedule prices both lanes (deposit standard = 0 bps,
 *                          withdraw fast = 12 bps, inside the bridge's 50 bps ceiling).
 *   [x] round-trip-verified  A funded, real-money Solana↔Starknet round trip on these
 *                          exact addresses reported `ROUND TRIP: PASS` on 2026-07-29
 *                          (`scripts/verify_mainnet.mjs --run`, 0.01 USDC): deposit
 *                          minted exactly at the sol_account (standard lane, 0 bps),
 *                          withdraw returned 0.009988 USDC (fast lane, 12 bps, inside
 *                          the 50 bps ceiling). Tx refs:
 *                            deposit  solana burn      5dicuR1NNhekuLgmPXHUbYdwL6jXiixTYMTNnxjGWyAtDL69LGZvVKHqpEGzGGLYAqnNJbtzLcSGWVpMBzNtxbPN
 *                            deposit  starknet receive 0x54568b9a274cfde167d010f28997bb59ab9cae89e37cf36afa33fa7422e537b
 *                            withdraw starknet burn    0x491471cb7036db81765abb0023280bba4fe32c965d61340654b67119b60ded2
 *                            withdraw solana receive   3n7NEYpVX9tnhBuLtF6Pnce7j8gCyx9Xh7xuSMPiRU9nvoD63ewHnnGbJPiqW8sEhHMa2fi6y99cvTVk2U61wYNS
 *                          The run also exercised leg-level resume in production: the
 *                          deposit mint was interrupted by an exhausted sponsorship
 *                          key and completed from persisted state on the next run.
 *   [x] paymaster-parity   Same run: AVNU's hosted mainnet paymaster sponsored this
 *                          SDK's custom sol_account class for both the counterfactual
 *                          deploy_and_invoke (probe tx 0x5b26ca5b6d65b551af8fa7185cf56275691b38f7db7c0be0f61883166d98e85,
 *                          1.316 STRK covered) and plain invokes (receive_message
 *                          4.489 STRK, deposit_for_burn 1.167 STRK).
 *
 * Sources (fetched 2026-07-29):
 *   - Starknet contracts : https://developers.circle.com/cctp/starknet-contracts
 *                          ("Mainnet contract addresses", domain 25)
 *   - Solana programs    : https://developers.circle.com/cctp/solana-programs
 *                          ("Mainnet program addresses", domain 5)
 *   - USDC addresses     : https://developers.circle.com/stablecoins/usdc-contract-addresses
 *   - Domain ids         : https://developers.circle.com/cctp/cctp-supported-blockchains
 *   - Attestation API    : https://developers.circle.com/cctp/technical-guide
 *                          (Mainnet → https://iris-api.circle.com)
 */
export const CCTP_MAINNET_CONFIG: CctpConfig = {
  // Public Starknet mainnet endpoint, mirroring the Sepolia default above. Override
  // with your own node for anything beyond a smoke test — the recovery scans page
  // through event history and will be rate-limited on a shared endpoint.
  starknetRpcUrl: "https://api.cartridge.gg/x/starknet/mainnet",
  // Production Iris. The sandbox host only attests testnet burns, so pointing a
  // mainnet burn at it silently never completes.
  attestationApi: "https://iris-api.circle.com",
  starknet: { ...CCTP_MAINNET_ADDRESSES.starknet },
  solana: { rpcUrl: "https://api.mainnet-beta.solana.com", ...CCTP_MAINNET_ADDRESSES.solana },
};
