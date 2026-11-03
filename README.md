# AnyStark

> ⚠️ **Unaudited code. Use at your own risk.**
>
> This code has not been audited or fully tested and may contain bugs or security vulnerabilities. It is provided “as is” without warranty of any kind. Do not use it in production or with real funds unless you have reviewed and tested it yourself.

An SDK that lets **any Starknet dapp** offer "Connect with an external wallet" — starting
with **Phantom** (Solana). A user's Solana Ed25519 key becomes the root signer of a
counterfactual Starknet account; signatures are verified on-chain (garaga Ed25519). An
optional CCTP bridge moves USDC between Solana and Starknet to fund/defund the account.

The SDK ships Phantom as a `@starknet-react/core` Connector whose `connect()` returns a
`SolanaAsStarknetAccount` (a starknet.js `Account` subclass), so consuming dapps add it to
their connector list and everything (`useAccount`, `useSendTransaction`, the connect modal)
works unchanged, with no Phantom-specific branching.

## Layout

| Path                       | Description                                                                                                                                                                |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts`       | Cairo Scarb package: the Ed25519-signed Starknet account (`sol_account`).                                                                                                  |
| `packages/core`            | `@starkware-libs/anystark-core`: framework-agnostic derivation, signer, Phantom provider, `SolanaAsStarknetAccount`.                                                       |
| `packages/react`           | `@starkware-libs/anystark-react`: a thin `@starknet-react/core` `Connector` whose `connect()` returns a core `SolanaAsStarknetAccount`.                                    |
| `packages/paymaster-proxy` | `@starkware-libs/anystark-paymaster-proxy`: a stateless SNIP-29 paymaster sponsorship proxy that holds the upstream API key server-side and enforces a sponsorship policy. |

One more package rounds out the workspace: `@starkware-libs/anystark-cctp` (the beta
Solana↔Starknet USDC bridge).

## Installing

The packages publish to npm under the `@starkware-libs` scope:
`@starkware-libs/anystark-core`, `@starkware-libs/anystark-cctp`,
`@starkware-libs/anystark-react`, and `@starkware-libs/anystark-paymaster-proxy`.

```bash
npm install @starkware-libs/anystark-core starknet
```

See [`docs/releasing.md`](docs/releasing.md) for the release flow.

## Starknet compatibility

`starknet` (starknet.js) is a peer dependency of the SDK packages, so you install it in
your own app. Use `starknet@8.9.2`, the version the SDK develops and tests against.

- `@starkware-libs/anystark-core` and `@starkware-libs/anystark-cctp` declare a peer range of `>=8.5.2 <11`.
- `@starkware-libs/anystark-react` declares `>=8.5.2 <9`. It is effectively capped below `9` because it also
  peer-requires `@starknet-react/core ^5.0.3`, whose own `starknet` peer is `^8.1.2`
  (i.e. `<9`); a react consumer therefore cannot satisfy both on starknet 9.x or 10.x.

Resolve a single copy of `starknet` in your app. Two resolved copies produce
structurally distinct `Account` and typed-data types, which fail to type-check at the SDK
boundary even when the versions are identical. After installing, run `npm ls starknet` to
confirm one version is resolved, and `npm dedupe` if more than one shows up.

What "compatible" means here, precisely: only the `8.5.2` floor and `8.9.2` (the
development and CI version) are tested. The committed lockfile resolves `8.9.2`, so
`npm ci` and CI run against `8.9.2`. The `8.5.2` floor is covered by a dedicated CI job
that forces a single resolved `starknet@8.5.2` across the workspace via an npm override
and runs the typecheck, test, and build suites against it. Versions above `8.9.2` up to
the `<11` ceiling (for `@starkware-libs/anystark-core` and
`@starkware-libs/anystark-cctp`) are permitted but are not covered by the test suite; the `<11` ceiling only
excludes a hypothetical breaking `11.x`, and does not imply that `9.x` or `10.x` have
been validated.

## Development

Requires Node `>=20` (see `.nvmrc`) and, for the contracts, the Starknet toolchain
(Scarb + Starknet Foundry via [starkup](https://github.com/software-mansion/starkup)).

```bash
npm install            # install + link all workspaces
npm run build          # build every package
npm test               # run unit tests
npm run lint           # lint
npm run typecheck      # type-check
```

The TypeScript packages are an npm-workspaces monorepo, with build, test, lint, and CI
wired per package.

For how the packages behave in a bundler (why garaga needs no Vite plugins, what loads
when, boot-size budgets, and SSR notes), see [`docs/vite-and-bundling.md`](docs/vite-and-bundling.md).

## Upgrading a deployed account

`sol_account` is upgradeable via the native `replace_class` path. `@starkware-libs/anystark-core`'s
`SolanaAsStarknetAccount` exposes `upgrade` for it. There is no auto-"latest" and no
current-class check: the SDK pins a single frozen class per chain and never tracks a
current upgrade target. New class versions are declared and published on-chain by the
SDK maintainer; the account owner (the end user, through their connected wallet) simply
picks which published class to upgrade to.

```ts
import { SolanaAsStarknetAccount } from "@starkware-libs/anystark-core";

// Manually upgrade a deployed account to an already-published (declared) class hash.
// The SDK maintainer declares new versions on-chain; the account owner just picks one.
const newClassHash = "0x<declared class hash>";
await account.upgrade(newClassHash);
```

- **`upgrade(newClassHash)`** invokes the account's self-authorized `upgrade`
  entrypoint. `newClassHash` is **required** (no default, no auto-latest). The target is
  validated (non-zero, in-field felt) and, before anything is sent, **confirmed declared
  on-chain**: upgrading to an undeclared class **permanently bricks** the account, so a
  target that is not a published (declared) class on this network is rejected with a
  client error instead of bricking the account.

**Fees.** Every account operation runs **paymaster-sponsored** (a Phantom / Solana user
holds no STRK), so the account requires a paymaster, and `upgrade()` is sponsored the
same way. Sponsoring the `upgrade` self-call, gated on an approved-class-hash allowlist,
is future work (proxy self-call sponsorship plus an on-chain registry; the frozen v1
contract already supports it via SNIP-9, so it can ship as an SDK-only change). There is
no other class to upgrade to yet.

> **⚠️ Storage-layout warning.** `replace_class` preserves the storage tree, so every
> replacement class **must** keep the `public_key: u256` field at the same
> name-derived slot — storage must stay append-only (never rename, retype, or remove
> `public_key`). Starknet storage addresses derive from the variable name
> (`sn_keccak("public_key")`), and that signer is what derives the user's address; a
> class that moves it orphans the root signer. See `packages/contracts/README.md`
> (_Upgrades_) for the full invariant. Whoever publishes a new version must declare
> **and** dry-run-validate the class before it is offered as an upgrade target.

**Relayer fee-at-risk.** Sponsored execution runs the user's signed call set through
the paymaster/relayer, which pays the on-chain gas. A call set can pass off-chain
simulation and still revert on-chain (a front-run state change, block-dependent logic);
when it does, the relayer pays for the reverted transaction while the SNIP-9 nonce rolls
back. This is inherent to SNIP-9 outside execution on current Starknet: an account cannot
catch an inner-call panic on-chain (`SafeDispatcher` error catching works only under test
cheat infrastructure), and the exposure is shared by every SNIP-9 account (OpenZeppelin,
Argent, Braavos). The `upgrade()` self-call's `identity()` library call into an
attacker-supplied class is one instance of this (it can loop or run out of gas on-chain
after simulating fine), but any sponsored call can, so it is a relayer-operations concern
rather than an upgrade-specific one. Operators bound it off-chain: simulate at a pending
block close to submission, cap per-transaction resources, rate-limit or deny-list senders,
and monitor failed sponsored transactions. See `packages/paymaster-proxy/README.md`
(_Security_) for the operator playbook.
