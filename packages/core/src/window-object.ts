// ─── StarknetWindowObject (deferred) ───
//
// The shipped drop-in surface is a @starknet-react/core Connector (see
// @starkware-libs/anystark-react) whose connect() returns a `SolanaAsStarknetAccount`. That fully covers any
// @starknet-react dapp with no Phantom-specific branching, which is the project's
// target. SolanaAsStarknetAccount being an Account subclass is the seam that makes it work.
//
// Implementing a get-starknet v4 `StarknetWindowObject` here would extend
// reach to consumers that DISCOVER wallets rather than import a connector: raw
// get-starknet, starknetkit, and non-React dapps. It does NOT improve the
// @starknet-react experience (still a connector in the list), so it's deferred
// until that broader reach is actually wanted.
//
// TODO: implement and export `getPhantomWindowObject(config): StarknetWindowObject`.
//   This is the right home for it (framework-agnostic core, sitting between the
//   connector and the Account). Sketch:
//
//   1. Depend on `@starknet-io/types-js` for the `StarknetWindowObject` + `RpcMessage`
//      types and the wallet-API RPC spec version.
//   2. Build a `SolanaAsStarknetAccount` (this module already owns derivation + the Account)
//      and a `PhantomProvider` for connect/events.
//   3. Return an object `{ id, name, version, icon, request, on, off }` whose
//      `request({ type, params })` implements the wallet_* methods:
//        - wallet_getPermissions
//        - wallet_requestAccounts   → PhantomProvider.connect(); return [address]
//        - wallet_requestChainId    → config.chainId
//        - wallet_deploymentData    → SolanaAsStarknetAccount.derivation (salt, calldata)
//                                     + the account's class hash, so a SNIP-9/paymaster can deploy
//        - wallet_addInvokeTransaction → SolanaAsStarknetAccount.execute(calls)  ← core path
//        - wallet_addDeclareTransaction (likely unsupported → throw)
//        - wallet_signTypedData     → sign via the wallet
//        - wallet_supportedSpecs / wallet_supportedWalletApi
//      plus `on('accountsChanged'|'networkChanged', …)` wired to PhantomProvider.subscribe().
//   4. Optionally inject it on `window` (e.g. `window.starknet_phantomEwc`) for
//      discovery, and add a matching thin connector in @starkware-libs/anystark-react that wraps it.
//   5. The fiddly part is conforming exactly to the types-js schema + the pinned
//      RPC spec version; pin and test against the versions @starknet-react/starknetkit
//      consume.

export {};
