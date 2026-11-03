// @starkware-libs/anystark-core: public entry point.

export { CHAIN_IDS } from "./config";
export type { ChainId, PaymasterConfig, PaymasterFeeMode, PhantomConnectorConfig } from "./config";
export {
  resolveDeployClassHash,
  deriveSolAccountAddress,
  pubkeyToU256Limbs,
} from "./key_to_address";
export type { SolAccountDerivation } from "./key_to_address";
export { buildEddsaSignatureFelts } from "./garaga";
export {
  SolanaAsStarknetSigner,
  assembleSignedMessage,
  feltToBase64Hash,
  MAX_MSG_LEN,
  MAX_LABEL_BYTES,
} from "./signer";
export type { SolanaSigner, SignBytes, SigningLabel } from "./signer";
export { LabeledExecutor } from "./labeled_executor";
export { PhantomProviderWrapper, getPhantomProvider } from "./provider";
export type { PhantomProvider, PhantomConnection, PhantomSubscription } from "./provider";
export { SolanaAsStarknetAccount } from "./account";
export type { CreateSolanaAccountParams } from "./account";

// The drop-in surface is the @starknet-react Connector in @starkware-libs/anystark-react (option A).
// A framework-agnostic StarknetWindowObject (option B, for non-starknet-react
// reach) is deferred — see ./window-object.ts for the TODO and implementation plan.
