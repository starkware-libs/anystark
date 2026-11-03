// ─── CCTP address constants (Solana-free) ───
// Pure domain/address literals for both networks, zero imports: safe for a
// consumer (e.g. a paymaster sponsorship policy) that needs the CCTP contract
// addresses without pulling @solana/web3.js, @solana/spl-token, or
// @coral-xyz/anchor. Exposed as the `@starkware-libs/anystark-cctp/addresses`
// subpath; see package.json's `exports`. ./config.ts imports these and adds
// the injected RPC/attestation URLs to assemble the full CctpConfig.
// The source of truth lives in @starkware-libs/anystark-core's `./cctp-addresses`
// subpath; this module re-exports it.

export {
  CCTP_MAINNET_ADDRESSES,
  CCTP_TESTNET_ADDRESSES,
  type CctpSolanaAddresses,
  type CctpStarknetAddresses,
} from "@starkware-libs/anystark-core/cctp-addresses";
