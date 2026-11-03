# @starkware-libs/anystark-cctp

> ⚠️ **Unaudited code. Use at your own risk.**
>
> This code has not been audited or fully tested and may contain bugs or security vulnerabilities. It is provided “as is” without warranty of any kind. Do not use it in production or with real funds unless you have reviewed and tested it yourself.

> **BETA.** A bidirectional, USDC-only bridge between Solana and Starknet over
> Circle CCTP V2, built to fund and defund an AnyStark account. The Solana
> `depositForBurn` / `receive` account-lists and PDA seeds mirror Circle's
> `circlefin/solana-cctp-contracts` examples and were validated end-to-end on
> Solana devnet and Starknet Sepolia.
>
> Mainnet ships as [`CCTP_MAINNET_CONFIG`](#cctp_mainnet_config): every address is
> verified against Circle's published mainnet tables, confirmed to exist
> on-chain, and **live-verified end-to-end on 2026-07-29** — a funded 0.01 USDC
> Solana↔Starknet round trip on the exact shipped addresses reported
> `ROUND TRIP: PASS` (tx refs in the `VERIFICATION STATUS` block in
> `src/config.ts`). To re-verify after any address or dependency change, run
> [`scripts/verify_mainnet.mjs`](scripts/README.md).

The bridge is **relayer-free**: the browser drives the burn on the source chain,
polls Circle for the attestation, and submits the permissionless `receive` on the
destination chain. Nothing is stored server-side. There are two directions:

- **Deposit** (Solana to Starknet): burn USDC on Solana, mint it at the
  counterfactual AnyStark account on Starknet. Used to fund the account.
- **Withdraw** (Starknet to Solana): burn USDC on Starknet from the AnyStark
  account, mint it to a Solana wallet's USDC associated-token account. Used to
  defund the account.

Every Starknet-side execution runs through the paymaster-sponsored
[`SolanaAsStarknetAccount`](../core) (`@starkware-libs/anystark-core`), which requires a
paymaster by construction; a Phantom / Solana user holds no STRK, so there is no
self-paid path. The Solana-side burn and receive are signed and fee-paid by the
connected Solana wallet in SOL.

## Installation

```sh
npm install @starkware-libs/anystark-cctp starknet
```

`starknet` (starknet.js) is a peer dependency, so you install it in your own app.
The Solana libraries (`@solana/web3.js`, `@solana/spl-token`, `@coral-xyz/anchor`)
are regular dependencies of this package and are pulled in automatically.

### Starknet compatibility

Use `starknet@8.9.2`, the version the SDK develops and tests against.
`@starkware-libs/anystark-cctp` declares a peer range of `>=8.5.2 <11`. Only the `8.5.2` floor
and `8.9.2` (the development and CI version) are tested; the committed lockfile
resolves `8.9.2`, so `npm ci` and CI run against it. The `8.5.2` floor
type-checks, tests, and builds with a single shared `starknet@8.5.2` but is not
covered by CI. Resolve a single copy of `starknet` in your app (run
`npm ls starknet`, and `npm dedupe` if more than one shows up); two resolved
copies fail to type-check at the SDK boundary. See the root README's
[Starknet compatibility](../../README.md#starknet-compatibility) section for the
full invariant.

### Lazy Solana libraries

The `@starkware-libs/anystark-cctp` entry is tiny (measured 3.76 kB). The heavy Solana libraries
load lazily, behind `await import(...)`, at the first bridge call that needs them,
so they stay off your app's boot path. Import `@starkware-libs/anystark-cctp` from the bridge
feature route (ideally behind a route-level `import()`) so even its small entry
stays out of the boot chunk. See
[`docs/vite-and-bundling.md` section 4](../../docs/vite-and-bundling.md#4-starkware-libsanystark-cctp-lazy-boundary).

### Solana-free addresses (`@starkware-libs/anystark-cctp/addresses`)

A consumer that only needs the CCTP addresses (for example, building a
paymaster sponsorship policy) can import the `./addresses` subpath instead of
the package root. It carries pure constants with zero imports, so it never
pulls in `@solana/web3.js`, `@solana/spl-token`, or `@coral-xyz/anchor` (not
even lazily):

```ts
import {
  CCTP_TESTNET_ADDRESSES,
  CCTP_MAINNET_ADDRESSES,
} from "@starkware-libs/anystark-cctp/addresses";

CCTP_TESTNET_ADDRESSES.starknet.tokenMessenger; // "0x04bDdE1E09a4B09a2F95d893D94a967b7717eB85A3f6dEcA8c080Ee01fBc3370"
```

Each constant has a `{ starknet, solana }` shape matching
[`CctpStarknetConfig`](#cctpstarknetconfig) / [`CctpSolanaConfig`](#cctpsolanaconfig)
minus `solana.rpcUrl`; `CCTP_TESTNET_CONFIG` and `CCTP_MAINNET_CONFIG` assemble
their `starknet` / `solana` fields from these same values.

The constants are defined in `@starkware-libs/anystark-core/cctp-addresses`
and re-exported here. A consumer that must not install this package's Solana
dependency tree at all (a backend image, for example) can import that core
subpath directly — core has no Solana dependencies.

### Buffer polyfill

`receiveOnSolana` (the Solana-side mint in the withdraw flow) constructs the
transaction with `Buffer`. Browsers do not ship a global `Buffer`, so the
consuming app must provide a polyfill (for example `vite-plugin-node-polyfills`,
or an explicit `globalThis.Buffer = Buffer` from the `buffer` package) before
calling it. The other bridge methods do not require it.

## Configuration

Every address and URL is injected through `CctpConfig`; there are no environment
reads or globals inside the package — including the Circle attestation host, which
is only ever read from `config.attestationApi`. Construct a `CctpBridge` with a
config:

```ts
import {
  CctpBridge,
  CCTP_MAINNET_CONFIG,
  CCTP_TESTNET_CONFIG,
} from "@starkware-libs/anystark-cctp";

const bridge = new CctpBridge(CCTP_TESTNET_CONFIG); // or CCTP_MAINNET_CONFIG
```

### `CctpConfig`

| Field            | Type                 | Description                                            |
| ---------------- | -------------------- | ------------------------------------------------------ |
| `starknetRpcUrl` | `string`             | Starknet JSON-RPC URL (recovery scans + nonce checks). |
| `attestationApi` | `string`             | Circle attestation API base URL.                       |
| `starknet`       | `CctpStarknetConfig` | Starknet-side domain and contract addresses.           |
| `solana`         | `CctpSolanaConfig`   | Solana-side RPC, domain, and program / mint addresses. |

### `CctpStarknetConfig`

| Field                | Type     | Description                                   |
| -------------------- | -------- | --------------------------------------------- |
| `domain`             | `number` | CCTP domain id for Starknet.                  |
| `messageTransmitter` | `string` | Starknet MessageTransmitter contract address. |
| `tokenMessenger`     | `string` | Starknet TokenMessenger contract address.     |
| `usdc`               | `string` | USDC token contract address on Starknet.      |

### `CctpSolanaConfig`

| Field                  | Type     | Description                             |
| ---------------------- | -------- | --------------------------------------- |
| `rpcUrl`               | `string` | Solana JSON-RPC URL.                    |
| `domain`               | `number` | CCTP domain id for Solana.              |
| `messageTransmitter`   | `string` | Solana MessageTransmitter program id.   |
| `tokenMessengerMinter` | `string` | Solana TokenMessengerMinter program id. |
| `usdcMint`             | `string` | USDC SPL mint address on Solana.        |

### `CCTP_TESTNET_CONFIG`

A ready-made testnet config wiring Solana devnet (domain 5) to Starknet Sepolia
(domain 25) against Circle's sandbox attestation API. A dapp can override any
field to point at a different network or its own RPC.

> **BETA.** `CCTP_TESTNET_CONFIG` carries addresses that were correct at the time
> of writing. Re-verify them against
> [Circle's CCTP documentation](https://developers.circle.com/cctp) before relying
> on them, and supply your own config for any network Circle updates.

### `CCTP_MAINNET_CONFIG`

Solana mainnet-beta (domain 5) ↔ Starknet mainnet (domain 25) against Circle's
production attestation API. Same shape as the testnet config, so switching
networks is a one-identifier change.

| Field                         | Value                                                                | Source                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `starknetRpcUrl`              | `https://api.cartridge.gg/x/starknet/mainnet`                        | public endpoint; override with your own node                                                           |
| `attestationApi`              | `https://iris-api.circle.com`                                        | [technical guide](https://developers.circle.com/cctp/technical-guide) (Mainnet row)                    |
| `starknet.domain`             | `25`                                                                 | [supported blockchains](https://developers.circle.com/cctp/cctp-supported-blockchains)                 |
| `starknet.messageTransmitter` | `0x02EBB5777B6dD8B26ea11D68Fdf1D2c85cD2099335328Be845a28c77A8AEf183` | [Starknet contracts](https://developers.circle.com/cctp/starknet-contracts) (`MessageTransmitterV2`)   |
| `starknet.tokenMessenger`     | `0x07d421B9cA8aA32DF259965cDA8ACb93F7599F69209A41872AE84638B2A20F2a` | [Starknet contracts](https://developers.circle.com/cctp/starknet-contracts) (`TokenMessengerMinterV2`) |
| `starknet.usdc`               | `0x033068F6539f8e6e6b131e6B2B814e6c34A5224bC66947c47DaB9dFeE93b35fb` | [USDC addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses)                    |
| `solana.rpcUrl`               | `https://api.mainnet-beta.solana.com`                                | public endpoint; override with your own node                                                           |
| `solana.domain`               | `5`                                                                  | [supported blockchains](https://developers.circle.com/cctp/cctp-supported-blockchains)                 |
| `solana.messageTransmitter`   | `CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC`                       | [Solana programs](https://developers.circle.com/cctp/solana-programs) (`MessageTransmitterV2`)         |
| `solana.tokenMessengerMinter` | `CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe`                       | [Solana programs](https://developers.circle.com/cctp/solana-programs) (`TokenMessengerMinterV2`)       |
| `solana.usdcMint`             | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`                       | [USDC addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses)                    |

> **Mainnet is address-verified and existence-checked, not round-trip verified.**
> The addresses match Circle's published mainnet tables and every one of them is
> confirmed live on-chain (Solana programs exist and are executable, Starknet
> contracts return a class hash, Starknet USDC answers `balanceOf`, production
> Iris answers on `/v2/messages/{domain}`). What has **not** happened yet is a
> funded round trip: the Solana `depositForBurn` / `receive` account-lists and PDA
> seeds have only ever been exercised on devnet. The reproducible verification
> ritual lives in [`scripts/`](scripts/README.md) — `--preflight` covers everything
> checkable without funds, `--run` performs the real-money round trip. The
> `VERIFICATION STATUS` block above `CCTP_MAINNET_CONFIG` in
> [`src/config.ts`](src/config.ts) is the single place that records the outcome.

## `CctpBridge`

```ts
new CctpBridge(config: CctpConfig)
```

All methods below are instance methods of `CctpBridge`.

### Attestation

```ts
fetchAttestation(sourceDomain: number, burnTxHash: string): Promise<Attestation>
```

Polls Circle's v2 messages API for a burn, keyed by the source CCTP domain and
the burn transaction hash. Returns the latest `Attestation`; call it until
`status === "complete"`, at which point `message` and `attestation` are populated.
A 404 (or an empty message set) is reported as
`status: "pending_confirmations"` with null fields rather than an error, so it is
safe to poll before the burn is indexed.

`burnTxHash` is chain-shaped. For the Solana domain, pass the base58 burn
signature that `depositFromSolana` returns; for every other domain, pass the
`0x`-prefixed hex transaction hash (on Starknet, the `transaction_hash` returned
by `account.execute`). The method serves both directions: the **deposit** flow
polls with the Solana domain and burn signature, the **withdraw** flow with the
Starknet domain and burn tx hash. Burns from an earlier session, where the
signature is no longer at hand, are discovered through `findRecoverableDeposits`
(see [In-flight recovery](#in-flight-recovery)).

### Deposit: Solana to Starknet

```ts
depositFromSolana(params: DepositParams): Promise<string>
```

Burns USDC on Solana (CCTP V2 `depositForBurn`) destined for the AnyStark account
on Starknet, and returns the base58 burn signature. It uses **standard finality**
with **`maxFee` 0**, so Circle charges no fee and the minted amount equals the
burned amount. An ephemeral `messageSentEventData` keypair partial-signs the
transaction; the connected Solana wallet adds the owner signature and pays the SOL
fee through `signAndSend`.

The recipient is the account's counterfactual address, which exists and can
receive the CCTP mint before any contract is deployed there. The first sponsored
`execute()` on that account deploys it.

```ts
import { CctpBridge, CCTP_TESTNET_CONFIG } from "@starkware-libs/anystark-cctp";
import { SolanaAsStarknetAccount } from "@starkware-libs/anystark-core";

const bridge = new CctpBridge(CCTP_TESTNET_CONFIG);

// The connected Phantom Solana provider (window.phantom.solana). Its
// signAndSendTransaction returns an object carrying the base58 signature.
const solana = window.phantom.solana;
const ownerPubkey = solana.publicKey.toBase58();
const signAndSend = async (tx: unknown) => {
  const { signature } = await solana.signAndSendTransaction(tx);
  return signature;
};

// `account` is the paymaster-sponsored SolanaAsStarknetAccount (see @starkware-libs/anystark-core).
// A paymaster is REQUIRED; the account executes sponsored through it.
const account = new SolanaAsStarknetAccount({
  signer, // Phantom-backed SolanaSigner
  rpcUrl: CCTP_TESTNET_CONFIG.starknetRpcUrl,
  classHash, // resolveDeployClassHash({ chainId }) from @starkware-libs/anystark-core
  paymaster: { nodeUrl: "https://<your-paymaster-proxy>/api/paymaster" },
});

// 1. Burn on Solana, targeting the AnyStark account address on Starknet.
const burnSig = await bridge.depositFromSolana({
  amount: 1_000_000n, // raw USDC, 6 decimals (1 USDC)
  starknetRecipient: account.address,
  ownerPubkey,
  signAndSend,
});

// 2. Poll Circle for the attestation, keyed by the Solana source domain and the
//    base58 burn signature.
let attested = await bridge.fetchAttestation(CCTP_TESTNET_CONFIG.solana.domain, burnSig);
while (attested.status !== "complete" || !attested.message || !attested.attestation) {
  await new Promise((r) => setTimeout(r, 4000));
  attested = await bridge.fetchAttestation(CCTP_TESTNET_CONFIG.solana.domain, burnSig);
}

// 3. Mint on Starknet with a permissionless receive_message, executed sponsored.
await account.execute([bridge.buildReceiveOnStarknetCall(attested.message, attested.attestation)]);
```

The sponsorship policy on your paymaster proxy must allowlist `receive_message`
on the Starknet MessageTransmitter (`config.starknet.messageTransmitter`), or the
sponsored `execute()` is rejected. See
[`@starkware-libs/anystark-paymaster-proxy`](../paymaster-proxy) for the policy generator.

### Withdraw: Starknet to Solana

```ts
buildWithdrawToOwnerCalls(amount: bigint, ownerPubkey: string): Promise<Call[]>
buildWithdrawToSolanaCalls(amount: bigint, recipientAta32: Uint8Array): Call[]
buildReceiveOnStarknetCall(message: string, attestation: string): Call
receiveOnSolana(p: ReceiveOnSolanaParams): Promise<string>
```

`buildWithdrawToOwnerCalls` derives the USDC associated-token account (ATA) for
`ownerPubkey` and builds the two burn calls that send USDC to it: an `approve` on
the Starknet USDC token and a `deposit_for_burn` on the Starknet TokenMessenger.
Pass the connected wallet's own pubkey to withdraw back to that wallet. The caller
is responsible for passing the intended owner: any pubkey's USDC ATA can be
targeted, so this call alone does not guarantee funds return to the connected
wallet.

`buildWithdrawToSolanaCalls` is the lower-level variant. It takes the raw 32-byte
recipient ATA directly (`solanaUsdcAtaBytes` produces it) and builds the same two
calls. It throws if the recipient is not exactly 32 bytes. The same
caller-owns-the-recipient caveat applies: whatever 32-byte ATA you pass is where
the USDC mints on Solana.

Both use **fast finality**. The `deposit_for_burn` `max_fee` is a ceiling on
Circle's fee (not on the burned amount): it is `amount / 200` (0.5%), floored at 1
so a very small burn never submits `max_fee` 0 and reverts.

```ts
import { CCTP_TESTNET_CONFIG } from "@starkware-libs/anystark-cctp";

const amount = 1_000_000n; // raw USDC (1 USDC)

// 1. Build and execute the burn on Starknet, sponsored through the paymaster.
const calls = await bridge.buildWithdrawToOwnerCalls(amount, ownerPubkey);
const { transaction_hash } = await account.execute(calls);

// 2. Poll Circle for the attestation, keyed by the Starknet source domain and the
//    0x burn tx hash.
let attested = await bridge.fetchAttestation(CCTP_TESTNET_CONFIG.starknet.domain, transaction_hash);
while (attested.status !== "complete" || !attested.message || !attested.attestation) {
  await new Promise((r) => setTimeout(r, 4000));
  attested = await bridge.fetchAttestation(CCTP_TESTNET_CONFIG.starknet.domain, transaction_hash);
}

// 3. Mint on Solana. Requires a browser Buffer polyfill. The connected wallet
//    signs and pays the SOL fee; the recipient USDC ATA is created idempotently.
await bridge.receiveOnSolana({
  message: attested.message,
  attestation: attested.attestation,
  ownerPubkey,
  signAndSend,
});
```

The sponsorship policy must allowlist `approve` on the Starknet USDC token
(`config.starknet.usdc`) and `deposit_for_burn` on the Starknet TokenMessenger
(`config.starknet.tokenMessenger`). See
[`@starkware-libs/anystark-paymaster-proxy`](../paymaster-proxy).

`buildReceiveOnStarknetCall` builds the permissionless
`receive_message(message, attestation)` call on the Starknet MessageTransmitter;
it is the Starknet-side mint used to complete a deposit (see the deposit flow and
recovery). `receiveOnSolana` runs the corresponding permissionless
`receive_message` on the Solana MessageTransmitter, creating the recipient's USDC
ATA idempotently when it does not yet exist.

> **BETA.** `depositFromSolana` and `receiveOnSolana` build their Solana
> instructions from account-lists and PDA seeds that mirror Circle's example
> programs. Re-verify them against Circle's live programs before mainnet use.

### Balances and addresses

```ts
solanaUsdcAta(ownerPubkey: string): Promise<string>
solanaUsdcAtaBytes(ownerPubkey: string): Promise<Uint8Array>
solanaUsdcBalance(ownerPubkey: string): Promise<bigint>
```

- `solanaUsdcAta` returns the wallet's USDC associated-token account as a base58
  address.
- `solanaUsdcAtaBytes` returns that same ATA as raw 32 bytes, the `mint_recipient`
  form that `buildWithdrawToSolanaCalls` expects.
- `solanaUsdcBalance` reads the wallet's raw USDC balance (6 decimals), returning
  `0n` when the ATA does not exist yet. Any other RPC failure throws, so a
  transport error never reads as a zero balance — treat a rejection as
  "unknown", not "empty".

```ts
const balance = await bridge.solanaUsdcBalance(ownerPubkey); // e.g. 2_500_000n = 2.5 USDC
const ata = await bridge.solanaUsdcAta(ownerPubkey);
```

### In-flight recovery

A transfer that burned on the source chain but never minted on the destination
has no destination footprint, so the bridge discovers it storage-free: from the
source chain (the user's own burn history) plus Circle's attestation, then dedups
against the destination's used-nonce check so completed transfers never resurface.
These two methods drive both the deposit happy path and recovery of anything left
in flight.

```ts
findRecoverableDeposits(ownerPubkey: string, starknetRecipient: string): Promise<RecoverableDeposit[]>
findRecoverableWithdrawals(starknetSender: string, solanaOwner: string): Promise<RecoverableWithdraw[]>
```

`findRecoverableDeposits` scans the connected wallet's recent Solana transaction
history (newest-first, paginated with a `before` cursor up to 10,000 signatures),
keeps the attested burns whose destination domain and `mint_recipient` match
`starknetRecipient`, and drops any whose nonce is already used on Starknet
(`is_nonce_used`). Complete each returned burn with a sponsored Starknet receive:

```ts
for (const deposit of await bridge.findRecoverableDeposits(ownerPubkey, account.address)) {
  await account.execute([bridge.buildReceiveOnStarknetCall(deposit.message, deposit.attestation)]);
}
```

`RecoverableDeposit.amount` is the gross burn amount read from the CCTP
BurnMessage. It equals the amount that mints on Starknet only for `maxFee`-0
transfers, which is exactly what `depositFromSolana` creates, so for burns this
bridge produced it is the minted amount.

`findRecoverableWithdrawals` discovers the AnyStark account's `DepositForBurn`
events on the Starknet TokenMessenger (keyed by depositor) over a recent
~1,500,000-block window, keeps those minting to `solanaOwner`'s USDC ATA, and
dedups against the Solana `used_nonce` PDA (present once the message has been
received). Complete each with a Solana receive:

```ts
for (const w of await bridge.findRecoverableWithdrawals(account.address, ownerPubkey)) {
  await bridge.receiveOnSolana({
    message: w.message,
    attestation: w.attestation,
    ownerPubkey,
    signAndSend,
  });
}
```

The scan bounds (a 10,000-signature cap on the deposit history scan and a
~1,500,000-block window on the withdraw event scan) keep each poll fast; a burn
older than those bounds is not surfaced.

## Types

### `Attestation`

Circle's attestation record for a burn.

| Field         | Type                | Description                                                  |
| ------------- | ------------------- | ------------------------------------------------------------ |
| `status`      | `AttestationStatus` | Circle status; poll until `"complete"`.                      |
| `message`     | `string \| null`    | The CCTP message bytes (hex), present once attested.         |
| `attestation` | `string \| null`    | Circle's attestation signature (hex), present once complete. |
| `eventNonce`  | `string \| null`    | The nonce Circle assigns at attestation time (V2).           |

### `AttestationStatus`

```ts
type AttestationStatus = "pending_confirmations" | "complete" | (string & {});
```

`"pending_confirmations"` and `"complete"` are the values the bridge branches on;
the `string & {}` arm keeps autocomplete while accepting any other status Circle
returns.

### `DepositParams`

| Field               | Type                               | Description                                         |
| ------------------- | ---------------------------------- | --------------------------------------------------- |
| `amount`            | `bigint`                           | Raw USDC amount (6 decimals).                       |
| `starknetRecipient` | `string`                           | Recipient AnyStark account address (felt hex).      |
| `signAndSend`       | `(tx: unknown) => Promise<string>` | Phantom signAndSendTransaction; returns base58 sig. |
| `ownerPubkey`       | `string`                           | Connected Solana wallet pubkey (base58).            |

### `ReceiveOnSolanaParams`

| Field         | Type                               | Description                                         |
| ------------- | ---------------------------------- | --------------------------------------------------- |
| `message`     | `string`                           | Attested CCTP message bytes (hex).                  |
| `attestation` | `string`                           | Circle attestation signature (hex).                 |
| `ownerPubkey` | `string`                           | Connected Solana wallet pubkey; recipient + payer.  |
| `signAndSend` | `(tx: unknown) => Promise<string>` | Phantom signAndSendTransaction; returns base58 sig. |

### `RecoverableDeposit`

| Field         | Type     | Description                                                        |
| ------------- | -------- | ------------------------------------------------------------------ |
| `burnSig`     | `string` | Solana burn transaction signature (base58).                        |
| `amount`      | `bigint` | Gross burn amount (6 decimals); the minted amount for this bridge. |
| `message`     | `string` | CCTP message bytes (hex).                                          |
| `attestation` | `string` | Circle attestation signature (hex).                                |

### `RecoverableWithdraw`

| Field         | Type     | Description                                   |
| ------------- | -------- | --------------------------------------------- |
| `starknetTx`  | `string` | Starknet `deposit_for_burn` transaction hash. |
| `message`     | `string` | CCTP message bytes (hex).                     |
| `attestation` | `string` | Circle attestation signature (hex).           |

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```
