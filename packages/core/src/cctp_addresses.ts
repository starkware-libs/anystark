// ─── CCTP address constants (Solana-free) ───
// Source of truth for the CCTP contract addresses, domains, and USDC mints, so a
// consumer that only installs @starkware-libs/anystark-core (not @starkware-libs/anystark-cctp,
// which pulls in @solana/web3.js, @solana/spl-token, and @coral-xyz/anchor) can still read
// them — e.g. a server-side paymaster sponsorship policy. Zero imports. Exposed as the
// `@starkware-libs/anystark-core/cctp-addresses` subpath; see package.json's `exports`.
// Not re-exported from the main entry, so it stays out of the boot chunk.
// @starkware-libs/anystark-cctp's ./addresses subpath re-exports these values.

export interface CctpStarknetAddresses {
  /** CCTP domain id for Starknet. */
  domain: number;
  messageTransmitter: string;
  tokenMessenger: string;
  usdc: string;
}

export interface CctpSolanaAddresses {
  /** CCTP domain id for Solana. */
  domain: number;
  messageTransmitter: string;
  tokenMessengerMinter: string;
  usdcMint: string;
}

/** Testnet addresses: Solana devnet (domain 5), Starknet Sepolia (domain 25). */
export const CCTP_TESTNET_ADDRESSES: {
  starknet: CctpStarknetAddresses;
  solana: CctpSolanaAddresses;
} = {
  starknet: {
    domain: 25,
    messageTransmitter: "0x04db7926C64f1f32a840F3Fa95cB551f3801a3600Bae87aF87807A54DCE12Fe8",
    tokenMessenger: "0x04bDdE1E09a4B09a2F95d893D94a967b7717eB85A3f6dEcA8c080Ee01fBc3370",
    usdc: "0x0512feAc6339Ff7889822cb5aA2a86C848e9D392bB0E3E237C008674feeD8343",
  },
  solana: {
    domain: 5,
    messageTransmitter: "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC",
    tokenMessengerMinter: "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe",
    usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  },
};

/**
 * Mainnet addresses: Solana mainnet-beta (domain 5), Starknet mainnet (domain 25).
 * Every value is transcribed from Circle's published tables; see the
 * ─── VERIFICATION STATUS ─── block on CCTP_MAINNET_CONFIG in @starkware-libs/anystark-cctp's
 * config.ts for the full provenance (address-verified, existence-checked,
 * round-trip-verified, paymaster-parity) and sources.
 */
export const CCTP_MAINNET_ADDRESSES: {
  starknet: CctpStarknetAddresses;
  solana: CctpSolanaAddresses;
} = {
  starknet: {
    // Domain is per-chain, not per-network: Starknet is 25 on mainnet and testnet.
    domain: 25,
    messageTransmitter: "0x02EBB5777B6dD8B26ea11D68Fdf1D2c85cD2099335328Be845a28c77A8AEf183",
    // CCTP V2 on Starknet folds TokenMessengerV2 and TokenMinterV2 into one
    // contract (TokenMessengerMinterV2), the way Solana does.
    tokenMessenger: "0x07d421B9cA8aA32DF259965cDA8ACb93F7599F69209A41872AE84638B2A20F2a",
    usdc: "0x033068F6539f8e6e6b131e6B2B814e6c34A5224bC66947c47DaB9dFeE93b35fb",
  },
  solana: {
    domain: 5,
    // Circle deploys the V2 programs at the same ids on mainnet-beta and devnet;
    // only the USDC mint differs between the clusters.
    messageTransmitter: "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC",
    tokenMessengerMinter: "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe",
    usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  },
};
