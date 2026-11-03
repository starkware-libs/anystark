REF-PHASE-3-OK

# Phase 3 - wallet connector

## Purpose

Let a Phantom (Solana) user connect and get their derived Starknet account in the dapp's
existing wallet UX, gated so wallet families never mix, with browser-free unit tests.

## Entry criteria

- P2 complete: the proxy route answers `paymaster_isAvailable`.

## Checklist

- [ ] Connector (or core-lane account) constructed behind the lazy seam, never at module
      scope of an SSR-evaluated module.
- [ ] `starknetRpcUrl` is the SAME node the app's Starknet provider uses.
- [ ] `paymaster.nodeUrl` points at the P2 proxy route.
- [ ] Static `signingLabel` set to the brand string.
- [ ] Cross-wallet-family gating implemented as a pure, unit-tested predicate.
- [ ] Unit tests on the `/testing` subpath; no browser needed.
- [ ] Connected-account UX: derived address shown, copy affordance, disconnect.

## PR plan

- **PR 3a "connector + gating":** construct `PhantomConnector` behind the lazy seam
  (`starknetRpcUrl` = the SAME node `StarknetConfig`'s provider uses, `chainId` from
  `CHAIN_IDS`, `paymaster: { nodeUrl: "<proxy route>" }`, `signingLabel:` a static brand
  string for now); add it to the connect UI; the cross-wallet-family gate as a pure,
  unit-tested predicate; unit tests on `@starkware-libs/anystark-react/testing`
  (`MockPhantomConnector`, `installMockPhantom`), no browser needed. Core lane:
  `SolanaAsStarknetAccount` plus `getPhantomProvider`/`PhantomProviderWrapper` instead
  of the connector.
- **PR 3b "account UX":** show the derived (counterfactual) address, a copy affordance,
  connected-state UI, disconnect. May fold into 3a (derived decision on size).

## Catalog

- **`starknetRpcUrl` is authoritative:** the account derived by the connector is pinned
  to the connector's RPC (the counterfactual derivation and the sponsored
  deploy-and-invoke run against it). Point `StarknetConfig`'s provider at the SAME node.
- **Counterfactual deploy:** the address exists before any deployment and can receive
  funds (including CCTP mints); the first sponsored `execute()` is a paymaster-funded
  `deploy_and_invoke`; a fresh key transacts with ZERO balance. UX rule: never block on
  "account not deployed", never require pre-funding; present the derived address as
  simply the user's address, with deployment invisible plumbing, never a user step.
- **Cross-wallet-family gating:** an EVM wallet derives a DIFFERENT Starknet account
  than a Solana wallet; "switching" families mid-session strands the user in an empty
  account. Never offer the other family's connectors while one family is connected.
  Implement the gate as a pure, unit-testable predicate (inputs: connected family,
  network), not scattered conditionals. In the connect UI, show the excluded family
  disabled with a one-line reason ("disconnect <wallet> first"); a silently missing
  option reads as a bug.
- **Connector surface:** the connector's `id` is `"phantomEwc"` (use it to find the
  connector in the `connectors` array), `name` is `"Phantom"`, and `request()` throws by
  design (send transactions through the connected account). `chainId` in the config is
  optional but recommended: set, it resolves the class hash locally and skips one RPC;
  omitted, the first `chainId()` call issues a `getChainId()` RPC.
- **Test without a browser:** `@starkware-libs/anystark-react/testing` provides
  `MockPhantomConnector` (a `PhantomConnector` wired to an in-memory provider),
  `MockPhantomProvider`, `installMockPhantom()` (the window-discovery path; its
  `uninstall()` restores exactly), and `MOCK_PHANTOM_PUBKEY`. It is a separate bundle
  entry: none of it lands in the runtime bundle. `MockPhantomConnector` requires
  `chainId` in its config (it throws without one) so an offline test never issues the
  `getChainId()` RPC.
- A static `signingLabel` (the brand string) is correct at this phase; per-action labels
  are P6.

## Verification

- [ ] Gating predicate unit tests cover both families and the mixed cases.
- [ ] Mock-based connect/sign tests pass in CI.
- [ ] Flag-off build still unchanged (P1 guard green).
- [ ] Exit smoke (no funds): connect and disconnect against real Phantom in a dev build;
      the displayed address matches `deriveSolAccountAddress` for the wallet's pubkey
      (with the class hash from `resolveDeployClassHash({ chainId })`).

## Exit criteria

- PR 3a (and 3b when split) merged, CI green; the no-funds smoke confirmed by the user.

Sentinels for resume probes: the connector construction in the seam module; the gating
predicate module and its tests.
