// @starkware-libs/anystark-cctp (beta): public entry point.
export { CctpBridge } from "./bridge";
export type {
  Attestation,
  AttestationStatus,
  DepositParams,
  ReceiveOnSolanaParams,
  RecoverableDeposit,
  RecoverableWithdraw,
} from "./bridge";
export { CCTP_MAINNET_CONFIG, CCTP_TESTNET_CONFIG } from "./config";
export type { CctpConfig, CctpStarknetConfig, CctpSolanaConfig } from "./config";
