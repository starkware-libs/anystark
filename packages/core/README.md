# @starkware-libs/anystark-core

> ⚠️ **Unaudited code. Use at your own risk.**
>
> This code has not been audited or fully tested and may contain bugs or security vulnerabilities. It is provided “as is” without warranty of any kind. Do not use it in production or with real funds unless you have reviewed and tested it yourself.

Framework-agnostic core of the AnyStark SDK. It makes a Phantom (Solana) Ed25519 key the
root signer of a counterfactual Starknet `sol_account`: the key derives a Starknet address,
signs Starknet operations as base64 text the wallet can display, and the account verifies
those signatures on-chain with garaga's Ed25519 circuit. Execution is always
paymaster-sponsored (SNIP-29), so a user who holds no STRK can still transact. This package
has no framework dependency; the drop-in `@starknet-react/core` connector lives in
`@starkware-libs/anystark-react` and builds on the `SolanaAsStarknetAccount` exported here.

## Installation

```bash
npm install @starkware-libs/anystark-core starknet
```

`starknet` (starknet.js) is a peer dependency, so you install it in your own app.

## Starknet compatibility

Use `starknet@8.9.2`, the version the SDK develops and tests against. `@starkware-libs/anystark-core`
declares a peer range of `>=8.5.2 <11`, where `8.5.2` is the floor and `8.9.2` is the tested
and CI version. Resolve a single copy of `starknet` in your app: two resolved copies produce
structurally distinct `Account` and typed-data types that fail to type-check at the SDK
boundary even when the versions are identical. Run `npm ls starknet` after installing to
confirm one version is resolved, and `npm dedupe` if more than one shows up. See the root
README's "Starknet compatibility" section for the full invariant.

## Exports

Everything below is exported from the package root (`@starkware-libs/anystark-core`).

| Export                      | Kind  | Summary                                                                       |
| --------------------------- | ----- | ----------------------------------------------------------------------------- |
| `SolanaAsStarknetAccount`   | class | starknet.js `Account` whose signer is a Solana key; `execute()` is sponsored. |
| `CreateSolanaAccountParams` | type  | Constructor params for the account.                                           |
| `SolanaAsStarknetSigner`    | class | starknet.js `Signer` backed by a Solana Ed25519 key.                          |
| `SolanaSigner`              | type  | Minimal wallet capability the signer needs (`pubkey` + `signBytes`).          |
| `SignBytes`                 | type  | Raw-bytes signing function `(msg) => Promise<Uint8Array>`.                    |
| `PhantomProviderWrapper`    | class | Vanilla wrapper over the injected Phantom provider.                           |
| `getPhantomProvider`        | fn    | Locate the injected `window.phantom.solana` provider, or `null`.              |
| `PhantomProvider`           | type  | Shape of the injected `window.phantom.solana` object.                         |
| `PhantomConnection`         | type  | A connected identity: `{ pubkey, address }`.                                  |
| `PhantomSubscription`       | type  | Handlers for `subscribe()` (connect / disconnect / accountChanged).           |
| `resolveDeployClassHash`    | fn    | Pinned `sol_account` class hash for a chain.                                  |
| `deriveSolAccountAddress`   | fn    | Counterfactual address for a pubkey + class hash.                             |
| `pubkeyToU256Limbs`         | fn    | 32-byte Ed25519 pubkey to its `{ pk, low, high }` limbs.                      |
| `SolAccountDerivation`      | type  | Derivation result: `pk`, `low`, `high`, `salt`, `calldata`, `address`.        |
| `assembleSignedMessage`     | fn    | Build the exact bytes the wallet signs.                                       |
| `feltToBase64Hash`          | fn    | 44-char standard base64 of a felt hash's 32 big-endian bytes.                 |
| `MAX_MSG_LEN`               | const | `303`: the contract's signed-message byte ceiling.                            |
| `MAX_LABEL_BYTES`           | const | `258`: the label byte budget (`MAX_MSG_LEN - 44 - 1`).                        |
| `buildEddsaSignatureFelts`  | fn    | Ed25519 signature to `sol_account` calldata felts (lazy garaga WASM).         |
| `CHAIN_IDS`                 | const | Starknet chain-id felts: `sepolia`, `mainnet`.                                |
| `ChainId`                   | type  | A chain-id felt string.                                                       |
| `PhantomConnectorConfig`    | type  | Injected connector config (rpc, chainId, paymaster, label).                   |
| `PaymasterConfig`           | type  | SNIP-29 paymaster service config: `nodeUrl`, `headers`, `feeMode`.            |
| `PaymasterFeeMode`          | type  | Who pays gas: `sponsored`, or `default` with a gas-token ceiling.             |

### The `cctp-addresses` subpath

`@starkware-libs/anystark-core/cctp-addresses` exports the CCTP contract
address constants (`CCTP_TESTNET_ADDRESSES`, `CCTP_MAINNET_ADDRESSES` and their
types). It is a separate entry point, not part of the package root, so it never
enters core's boot chunk. `@starkware-libs/anystark-cctp` re-exports these same
constants from its `./addresses` subpath; they live here so a consumer that
installs only core (no Solana dependency tree) can read them.

## Quick start

Detect Phantom, connect, build the account, and send a sponsored transaction. A `paymaster`
is required: the account executes only through a SNIP-29 paymaster.

```ts
import {
  PhantomProviderWrapper,
  SolanaAsStarknetAccount,
  resolveDeployClassHash,
  CHAIN_IDS,
} from "@starkware-libs/anystark-core";

const phantom = PhantomProviderWrapper.detect();
if (!phantom) throw new Error("Phantom is not installed.");

// Prompts the wallet; returns the raw 32-byte pubkey and its base58 address.
const connection = await phantom.connect();

const account = new SolanaAsStarknetAccount({
  signer: phantom.asSigner(connection),
  rpcUrl: "https://<your-starknet-rpc>",
  classHash: resolveDeployClassHash({ chainId: CHAIN_IDS.sepolia }),
  paymaster: { nodeUrl: "https://<your-proxy>/api/paymaster" },
  signingLabel: "MyApp: Starknet transaction",
});

// The first execute() also deploys the counterfactual account, bundled into the
// same sponsored transaction via SNIP-29 deploy_and_invoke.
const { transaction_hash } = await account.execute([
  {
    contractAddress: "0x<token>",
    entrypoint: "transfer",
    calldata: ["0x<recipient>", "0x1", "0x0"],
  },
]);
```

`SolanaAsStarknetAccount` extends starknet.js `Account`, so read paths (`callContract`,
`getNonce`, and the rest of `AccountInterface`) work as usual; only `execute` and `upgrade`
are specialized to run sponsored.

## Sponsored execution model

`SolanaAsStarknetAccount.execute(calls, detail?)` always runs paymaster-sponsored under
SNIP-29. A Phantom / Solana user holds no STRK, so there is a single execution path and it
is the sponsored one. `detail` (nonce, resource bounds, version) is accepted for
`AccountInterface` compatibility but ignored: those fields are paymaster-owned under
SNIP-29.

Each `execute()` follows an explicit build, verify, sign, execute pipeline:

1. **build**: `paymaster_buildTransaction` returns the SNIP-9 v2 typed data the wallet is
   asked to sign, plus a fee quote.
2. **verify**: the returned typed data is checked against what was requested, before
   anything is signed (see the integrity guard below).
3. **sign**: the wallet signs the typed data. Signing folds the account address into the
   SNIP-12 hash, so the signature is bound to this account and cannot be redirected.
4. **execute**: `paymaster_executeTransaction` submits and the service pays.

### Pre-sign integrity guard

The paymaster's build response is attacker-controlled input: a compromised paymaster could
slip in an extra call or mutate calldata to obtain a valid signature over calls the user
never approved. Before signing, the SDK verifies:

- **Calls match exactly.** Every requested call's `To`, `Selector` (compared as
  `getSelectorFromName(entrypoint)`), and `Calldata` must equal the returned call, and the
  call count must match. It refuses to sign calls that were not requested.
- **Chain-id domain is pinned.** The typed-data domain `chainId` must equal the account's
  chain (both hex/decimal felt and `SN_SEPOLIA`-style shortstring encodings are accepted).
  The counterfactual address is chain-independent, so a wrong-chain domain would otherwise
  fold this address into a signature valid on another network.
- **Deployment echo matches.** On the first-use `deploy_and_invoke`, the echoed deployment
  payload (`address`, `class_hash`, `salt`, `calldata`) must equal what the SDK sent.
- **Gas-token repayment is bound** (default fee mode only). The single appended repayment
  call must be an ERC-20 `transfer` to the configured gas token, for exactly the quoted
  amount, and that quote must not exceed the caller's `maxFeeInGasToken` ceiling.

### Fee modes (`PaymasterFeeMode`)

`PaymasterConfig.feeMode` selects who pays, and defaults to `sponsored`:

```ts
import type { PaymasterConfig } from "@starkware-libs/anystark-core";

// Service pays (requires a sponsorship deal). This is the default.
const sponsored: PaymasterConfig = {
  nodeUrl: "https://<your-proxy>/api/paymaster",
  feeMode: { mode: "sponsored" },
};

// Account repays the service in a gas token via a transfer the paymaster appends.
// maxFeeInGasToken caps that repayment; the guard rejects any quote above it.
const gasToken: PaymasterConfig = {
  nodeUrl: "https://<your-proxy>/api/paymaster",
  headers: { "x-api-key": "<key>" },
  feeMode: {
    mode: "default",
    gasToken: "0x<gas-token-address>",
    maxFeeInGasToken: 1_000_000_000_000_000n,
  },
};
```

`maxFeeInGasToken` is an SDK-side ceiling on top of starknet.js's `FeeMode`; the signing
guard enforces it locally. `headers` are sent with every paymaster request (for example an
API key).

### First-use counterfactual deploy

The account address exists before any code is deployed, so it can receive funds (for
example CCTP mints) before its first transaction. The first `execute()` on an undeployed
account bundles the counterfactual deployment into the same sponsored transaction via
SNIP-29 `deploy_and_invoke`. Concurrent first calls are de-duplicated: a second call that
starts before the deploy is accepted waits for it and then issues a plain sponsored invoke,
rather than bundling a second deployment. After deployment the account caches that state and
skips the on-chain probe on later calls.

```ts
// Cheap on-chain check of whether the account contract is deployed yet.
const deployed: boolean = await account.isDeployed();
```

`isDeployed()` returns `false` only for a genuinely undeployed account (RPC
`CONTRACT_NOT_FOUND`); any other RPC error propagates rather than being reported as "not
deployed".

## Address derivation

A Phantom user's Starknet address is counterfactually derived from their Ed25519 public key
and the pinned `sol_account` class hash. Derive it directly to display or pre-fund the
address before deploy.

```ts
import {
  deriveSolAccountAddress,
  resolveDeployClassHash,
  CHAIN_IDS,
} from "@starkware-libs/anystark-core";

const classHash = resolveDeployClassHash({ chainId: CHAIN_IDS.sepolia });
const derivation = deriveSolAccountAddress(pubkey32, classHash); // pubkey32: Uint8Array (32 bytes)
console.log("counterfactual address:", derivation.address);
```

- **`resolveDeployClassHash({ chainId })`** returns the pinned (frozen) `sol_account` class
  hash for the chain, and throws if the chain is unknown. It accepts anything carrying a
  `chainId` (a full `PhantomConnectorConfig` or a bare `{ chainId }`).
- **`deriveSolAccountAddress(pubkey32, classHash)`** returns a `SolAccountDerivation`. It
  reads the 32-byte key as a little-endian u256, then computes
  `salt = poseidon([low, high])`, `calldata = [low, high]` as hex felts, and
  `address = calculateContractAddressFromHash(salt, classHash, calldata, 0)`.
- **`pubkeyToU256Limbs(pubkey32)`** returns `{ pk, low, high }` and is the single source of
  truth for the fund-critical pubkey encoding. It rejects a wrong length (not 32 bytes), the
  zero key, and a non-canonical key (`y >= 2^255 - 19`), mirroring the contract constructor
  so the SDK never derives an address whose account would revert at deploy.

`SolAccountDerivation` fields:

| Field      | Type       | Meaning                                                                   |
| ---------- | ---------- | ------------------------------------------------------------------------- |
| `pk`       | `bigint`   | The 32-byte pubkey read as a little-endian u256. Derivation intermediate. |
| `low`      | `bigint`   | Low 128-bit limb of `pk`.                                                 |
| `high`     | `bigint`   | High 128-bit limb of `pk`.                                                |
| `salt`     | `string`   | The counterfactual-address salt, `poseidon([low, high])`.                 |
| `calldata` | `string[]` | Constructor calldata `[low, high]` as hex felts.                          |
| `address`  | `string`   | The counterfactual Starknet address.                                      |

### The pinned class hash (fund-critical)

The counterfactual address derives from the class hash, so each chain pins a single frozen
`sol_account` class hash. Changing it derives different addresses and would strand funds
already bridged to the old ones. The pinned sepolia value is:

```
0x07ec6a68af00a71582569f94ee3ec85eb530365a06b6b7cefbef8f2f8f6c2288
```

Always obtain it through `resolveDeployClassHash({ chainId: CHAIN_IDS.sepolia })` rather than
hardcoding it. The hash is fixed by the compiled Sierra and locked by tests; see
`packages/contracts/README.md` for how it is computed and kept in sync.

## Signing

`SolanaAsStarknetAccount` builds its signer for you from the `signer` and `signingLabel`
params, so most integrations pass a label through the account and read no further. Use
`SolanaAsStarknetSigner` directly only if you drive starknet.js primitives yourself.

```ts
import { SolanaAsStarknetSigner, type SolanaSigner } from "@starkware-libs/anystark-core";

const solanaSigner: SolanaSigner = phantom.asSigner(connection);
const signer = new SolanaAsStarknetSigner(solanaSigner, "MyApp: Starknet transaction");
```

The label may also be a `LabeledExecutor`, when the readable text is per-action and known only
at sign time:

```ts
const labeledExecutor = new LabeledExecutor("MyApp");
const signer = new SolanaAsStarknetSigner(solanaSigner, labeledExecutor);
```

`SolanaAsStarknetSigner` extends the starknet.js `Signer` and overrides `signRaw`: it renders
the operation hash as base64 text (optionally after a readable label), asks the wallet to
sign that text, and returns the garaga Ed25519 bundle as the signature. `getPubKey()` throws
by design: the Solana Ed25519 key is 256-bit and does not fit into a felt, so there is no
STARK public key to return.

`SolanaSigner` is the minimal capability an external Solana wallet provides:

```ts
interface SolanaSigner {
  readonly pubkey: Uint8Array; // 32-byte Ed25519 public key
  signBytes: SignBytes; // (message: Uint8Array) => Promise<Uint8Array>, a 64-byte signature
}
```

### The signing label

`signingLabel` is an optional human-readable string placed before the base64 hash in every
signed message, so the wallet popup shows the user what they approve. The label is
**advisory**: Ed25519 covers every byte (nobody can alter a signed label), but the chain does
not check the label against the calls. Pass a succinct sentence, for example
`"AppName: transfer 25 USDC to alice.strk"`. Control characters and invisible or
text-reordering characters (Unicode `Cc`, `Cf`, `Zl`, `Zp`, `Cs`: `\n` and the other C0/C1
controls, bidi overrides and isolates, zero-width characters, the BOM, `U+2028`/`U+2029`, lone
surrogates) are rejected, so a label cannot hide the real hash from the wallet's view or
reorder what it shows.

`signingLabel` is `string | LabeledExecutor`: a string for one static label on every signature,
a `LabeledExecutor` for a per-action label ("buy 1 STRK for 2 USDC") known only at sign time.

```ts
const labeledExecutor = new LabeledExecutor("MyApp"); // default label when execute() gets none

const account = new SolanaAsStarknetAccount({ ...params, signingLabel: labeledExecutor });

// Route the action through the executor: its label is set for this call only, consumed
// at sign time, and cleared afterwards. Concurrent calls are serialized, so a label can
// never attach to another call's signature.
await labeledExecutor.execute(account, calls, `MyApp: withdraw ${amount} USDC`);
```

Omit the label argument to sign with the constructor's default; pass `''` to sign the bare
hash for that one call. `LabeledExecutor` requires one invariant: **every** `execute()` on the
wired account goes through the instance. A bypassing `account.execute()` issued while the
executor is idle now fails at sign time with a descriptive error, instead of signing under a
wrong or default label; one that overlaps a labeled call in flight is still shown that call's
label undetected. See the class doc for the rest of the contract (not reentrant, no timeout,
await the returned promise).

### Wire format

`assembleSignedMessage(hashHex, label?)` builds the exact bytes the wallet signs and the
account verifies:

- no label: `base64(hash)` (44 bytes)
- with label: `utf8(label)` + `\n` + `base64(hash)` (`label` + 1 + 44 bytes)

The trailing 44 bytes are always the standard base64 (alphabet `A-Z a-z 0-9 + /`, one `=`
pad) of the hash's 32 big-endian bytes, which is exactly what the `sol_account` decodes and
compares u256-exact. `feltToBase64Hash(hashHex)` produces that 44-char string on its own.

The account re-hashes the whole message on every validation, so the message length sets a
recurring per-transaction gas cost. `MAX_MSG_LEN` is `303` (the 3-block ceiling
`64 + 303 + 17 = 384 = 3 * 128`) and `MAX_LABEL_BYTES` is `258`; a longer label is rejected
before signing. Each extra SHA-512 block is roughly +5.3M sierra gas on every validation:

| Label size       | Signed bytes | SHA-512 blocks | Notes                                                                                     |
| ---------------- | ------------ | -------------- | ----------------------------------------------------------------------------------------- |
| none             | 44           | 1              | Cheapest, but not recommended: the user signs an opaque blob, so the popup is unreadable. |
| up to 130 chars  | up to 175    | 2              | A full sentence, e.g. `"AppName: transfer 25 USDC to alice.strk"`.                        |
| 131 to 258 chars | up to 303    | 3              | The maximum; `MAX_MSG_LEN = 303`.                                                         |
| over 258 chars   | over 303     | -              | Rejected before signing, and on-chain (`MSG_TOO_LONG`).                                   |

There is no gas difference between a 3-char and a 130-char label (both are 2 blocks), so use
the block you already bought: keep the label to one succinct sentence. See
`packages/contracts/README.md` (_Message binding_) for the on-chain side.

## Phantom provider

`getPhantomProvider()` locates the injected Solana provider, preferring
`window.phantom.solana` and falling back to `window.solana` (the shared injection point other
wallets populate), returning it only when its `isPhantom` guard passes, else `null`.
`PhantomProviderWrapper` is the vanilla wrapper you normally use; construct it via
`PhantomProviderWrapper.detect()` (which returns `null` when Phantom is not available) or
directly with a `PhantomProvider`.

| Member                          | Signature                                                            | Purpose                                                                                |
| ------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `PhantomProviderWrapper.detect` | `() => PhantomProviderWrapper \| null`                               | Wrap the injected provider, or `null` when Phantom is not present.                     |
| `connect`                       | `(opts?: { onlyIfTrusted?: boolean }) => Promise<PhantomConnection>` | Prompt (or silently restore with `onlyIfTrusted`) and return the identity.             |
| `disconnect`                    | `() => Promise<void>`                                                | Disconnect the wallet.                                                                 |
| `current`                       | `() => PhantomConnection \| null`                                    | The currently-connected identity, or `null`.                                           |
| `signBytes`                     | `SignBytes`                                                          | Bound raw-bytes signer; hand it directly to a `SolanaSigner`.                          |
| `asSigner`                      | `(connection: PhantomConnection) => SolanaSigner`                    | A `SolanaSigner` pinned to a connection's pubkey snapshot plus this bound `signBytes`. |
| `signAndSendTransaction`        | `(tx: unknown) => Promise<string>`                                   | Sign and broadcast a Solana transaction; returns the base58 signature.                 |
| `subscribe`                     | `(handlers: PhantomSubscription) => () => void`                      | Subscribe to connect / disconnect / accountChanged; returns an unsubscribe function.   |

`PhantomConnection` is `{ pubkey: Uint8Array; address: string }`. `PhantomSubscription` has
optional `onConnect`, `onDisconnect`, and `onAccountChanged` handlers.

```ts
const unsubscribe = phantom.subscribe({
  onConnect: (c) => console.log("connected", c?.address),
  onDisconnect: () => console.log("disconnected"),
  onAccountChanged: (c) => console.log("account changed", c?.address ?? "(none)"),
});
// later: unsubscribe();
```

`asSigner(connection)` pins the pubkey to the connection the account address was derived
from, so a later `accountChanged` event cannot silently re-point the signer to a different
key. `signAndSendTransaction` is used for the Solana leg of a CCTP bridge (see
`@starkware-libs/anystark-cctp`); it keeps any pre-attached partial signatures on the transaction.

### Browser-only at call time

The `@starkware-libs/anystark-*` packages are built for browser SPAs. No `window` / `document` access
happens at import time, so bundling and SSR module evaluation do not crash. But
`PhantomProviderWrapper.detect()` (and `getPhantomProvider()`) read `window`, so they are
browser-only at call time: construct the provider inside client-only code (a lazy route, a
`useEffect`, or a `"use client"` boundary), never at the module scope of an SSR-evaluated
module. See `../../docs/vite-and-bundling.md` (section 3) for the full SSR and no-plugin
notes.

## Low-level: Ed25519 signature felts

`buildEddsaSignatureFelts(pubkey, sig64, msg)` turns a raw Phantom Ed25519 signature into the
hex calldata felts the `sol_account` deserializes as an `EdDSASignatureWithHint`. It is the
same call `SolanaAsStarknetSigner` makes internally; use it only if you assemble Starknet
signatures yourself.

```ts
import { buildEddsaSignatureFelts } from "@starkware-libs/anystark-core";

const felts: string[] = await buildEddsaSignatureFelts(pubkey32, sig64, msg);
```

- `pubkey`: the 32-byte Ed25519 public key (`publicKey.toBytes()`).
- `sig64`: the 64-byte Phantom signature (`R` then `s`).
- `msg`: the exact bytes that were signed (see `assembleSignedMessage`).

The first call lazily loads and initializes the garaga WASM (which computes the MSM and sqrt
hints), so garaga stays off the app boot path and only loads when the user actually signs.
For bundler behavior (why garaga needs no Vite plugins, what loads when, and boot-size
budgets) see `../../docs/vite-and-bundling.md`.

## Upgrading a deployed account

`sol_account` is upgradeable via the native `replace_class` path.
`SolanaAsStarknetAccount.upgrade(newClassHash)` invokes the account's self-authorized
`upgrade` entrypoint. `newClassHash` is required: the SDK pins a single frozen class per chain
and does not track a "latest" upgrade target, so the owner chooses which published class to
upgrade to.

```ts
// Upgrade a deployed account to an already-published (declared) class hash.
const newClassHash = "0x<declared class hash>";
await account.upgrade(newClassHash);
```

Before anything is sent, `upgrade` validates the target (non-zero, in-field felt) and
confirms it is declared on-chain: upgrading to an undeclared class permanently bricks the
account, so a target that is not a published class on this network is rejected with a client
error. `upgrade` runs paymaster-sponsored the same way as `execute`; a paymaster whose policy
does not allowlist the `upgrade` self-call rejects it, surfaced as an error.

> **Storage-layout warning.** `replace_class` preserves the storage tree, so every
> replacement class must keep the `public_key: u256` field at the same name-derived slot
> (storage must stay append-only; never rename, retype, or remove `public_key`). Starknet
> storage addresses derive from the variable name (`sn_keccak("public_key")`), and that
> signer is what derives the user's address; a class that moves it orphans the root signer.
> See `packages/contracts/README.md` (_Upgrades_) for the full invariant. Whoever publishes a
> new version must declare and dry-run-validate the class before it is offered as an upgrade
> target.
