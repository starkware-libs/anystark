// @starkware-libs/anystark-react: public entry point.
export { PhantomConnector } from "./connector";
// The connector's config types, re-exported so dapps don't need @starkware-libs/anystark-core.
export type { PaymasterConfig, PhantomConnectorConfig } from "@starkware-libs/anystark-core";
// The recommended signingLabel wiring, re-exported for the same reason.
export { LabeledExecutor } from "@starkware-libs/anystark-core";
// Address-derivation + deploy-class-hash helpers, re-exported so a dapp can derive
// the counterfactual sol_account address (e.g. to display it or pre-fund it) and
// resolve the deploy class hash with only @starkware-libs/anystark-react as a dependency.
export { deriveSolAccountAddress, resolveDeployClassHash } from "@starkware-libs/anystark-core";
export type { ChainId, SolAccountDerivation } from "@starkware-libs/anystark-core";
