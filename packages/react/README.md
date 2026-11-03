# @starkware-libs/anystark-react

> ⚠️ **Unaudited code. Use at your own risk.**
>
> This code has not been audited or fully tested and may contain bugs or security vulnerabilities. It is provided “as is” without warranty of any kind. Do not use it in production or with real funds unless you have reviewed and tested it yourself.

A [`@starknet-react/core`](https://github.com/apibara/starknet-react) `Connector` that
adds **Phantom** (Solana) alongside native Starknet wallets. Drop `PhantomConnector` into
your `connectors` list and `useAccount` / `useSendTransaction` / the connect modal work
unchanged, with no Phantom-specific branching.

Under the hood a user's Phantom (Solana) Ed25519 key becomes the root signer of a
counterfactual Starknet account. `connect()` returns a `SolanaAsStarknetAccount` (a
starknet.js `Account` subclass, from `@starkware-libs/anystark-core`) that runs paymaster-sponsored and
bundles the counterfactual deploy on first use, so any code holding an `AccountInterface`
drives it the same way it drives a native wallet.

## Installation

```bash
npm install @starkware-libs/anystark-react @starknet-react/core starknet
```

`@starkware-libs/anystark-core` is a direct dependency of `@starkware-libs/anystark-react`,
so it is always installed with it; you import the connector, its config types, and the
derivation helpers from `@starkware-libs/anystark-react`, and anything else (for example
`CHAIN_IDS`) from `@starkware-libs/anystark-core`.

### Starknet compatibility

`starknet` (starknet.js) is a peer dependency, so you install it in your own app. Use
`starknet@8.9.2`, the version the SDK develops and tests against.

`@starkware-libs/anystark-react` declares a `starknet` peer range of `>=8.5.2 <9`. It is capped below `9`
because it also peer-requires `@starknet-react/core ^5.0.3`, whose own `starknet` peer is
`<9`; a react consumer therefore cannot satisfy both above the `9.x` line. The `8.5.2`
floor type-checks, tests, and builds with a single shared `starknet@8.5.2`, and `8.9.2` is
the tested version that the committed lockfile and CI resolve.

Resolve a single copy of `starknet` in your app: two resolved copies produce structurally
distinct `Account` and typed-data types that fail to type-check at the SDK boundary even
when the versions are identical. Run `npm ls starknet` after installing to confirm one
version, and `npm dedupe` if more than one shows up.

## Quick start

Construct a `PhantomConnector` with your RPC URL, chain id, and a **required** paymaster,
then pass it to `StarknetConfig` in the `connectors` list. Point `StarknetConfig` at the
same Starknet node the connector uses (see [`starknetRpcUrl`](#configuration) for why it is
authoritative).

```tsx
import type { ReactNode } from "react";
import { StarknetConfig, jsonRpcProvider } from "@starknet-react/core";
import { sepolia } from "@starknet-react/chains";
import { PhantomConnector } from "@starkware-libs/anystark-react";
import { CHAIN_IDS } from "@starkware-libs/anystark-core";

const STARKNET_RPC_URL = "https://<your-starknet-rpc>";

const phantom = new PhantomConnector({
  starknetRpcUrl: STARKNET_RPC_URL,
  chainId: CHAIN_IDS.sepolia,
  paymaster: { nodeUrl: "https://<your-proxy>/api/paymaster" },
  signingLabel: "MyApp: Starknet transaction",
});

export function Providers({ children }: { children: ReactNode }) {
  return (
    <StarknetConfig
      chains={[sepolia]}
      provider={jsonRpcProvider({ rpc: () => ({ nodeUrl: STARKNET_RPC_URL }) })}
      connectors={[phantom]}
      autoConnect
    >
      {children}
    </StarknetConfig>
  );
}
```

From there the standard `@starknet-react/core` hooks work as-is:

```tsx
import { useAccount, useConnect, useSendTransaction } from "@starknet-react/core";

function TransferButton() {
  const { account, address } = useAccount();
  const { connect, connectors } = useConnect();
  const { sendAsync } = useSendTransaction({
    calls: [
      {
        contractAddress: "0x<token>",
        entrypoint: "transfer",
        calldata: ["0x<recipient>", "0x1", "0x0"],
      },
    ],
  });

  if (!account) {
    const phantom = connectors.find((c) => c.id === "phantomEwc");
    return (
      <button onClick={() => phantom && connect({ connector: phantom })}>Connect Phantom</button>
    );
  }

  return (
    <div>
      <p>{address}</p>
      <button onClick={() => sendAsync()}>Send</button>
    </div>
  );
}
```

The `paymaster` is required and every transaction runs sponsored (service-paid): a Phantom
user holds no STRK. The **first** transaction also carries the counterfactual account
deployment, sponsored the same way, so no separate deploy step is needed.

## Configuration

`PhantomConnector`'s constructor takes a `PhantomConnectorConfig` (re-exported from
`@starkware-libs/anystark-react`):

| Field            | Type                          | Required | Description                                                                                                                           |
| ---------------- | ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `starknetRpcUrl` | `string`                      | yes      | Starknet JSON-RPC URL the derived account talks to. Authoritative (see below).                                                        |
| `chainId`        | `ChainId`                     | no       | Starknet chain id (see `CHAIN_IDS` in `@starkware-libs/anystark-core`). Resolves the `sol_account` class hash and skips one RPC call. |
| `paymaster`      | `PaymasterConfig`             | yes      | SNIP-29 paymaster. The connected account always executes sponsored transactions through it.                                           |
| `signingLabel`   | `string` or `LabeledExecutor` | no       | Human-readable label shown in the Phantom popup before each signature. Bounded to 258 UTF-8 bytes.                                    |

**`starknetRpcUrl` is authoritative.** The returned account is pinned to it: the
counterfactual address derivation and the sponsored deploy-and-invoke on first use all run
against that RPC. Point your `StarknetConfig` provider at the same node. If you pass a
`StarknetConfig` provider on a different chain, `account(provider)` compares chain ids and
throws a descriptive mismatch error rather than talking to two networks at once.

**`chainId`** is optional. When set, the connector resolves the `sol_account` deploy class
hash locally and reports the chain id without a network round-trip. When omitted, the first
`chainId()` call issues one `getChainId()` RPC against `starknetRpcUrl` and memoizes the
result. Use the values in `CHAIN_IDS` from `@starkware-libs/anystark-core` (`CHAIN_IDS.sepolia`,
`CHAIN_IDS.mainnet`).

**`paymaster`** is a `PaymasterConfig` (also re-exported from `@starkware-libs/anystark-react`):

| Field     | Type                     | Required | Description                                                                    |
| --------- | ------------------------ | -------- | ------------------------------------------------------------------------------ |
| `nodeUrl` | `string`                 | yes      | Paymaster JSON-RPC URL (the SNIP-29 `paymaster_*` namespace).                  |
| `headers` | `Record<string, string>` | no       | Extra HTTP headers sent with every paymaster request (for example an API key). |
| `feeMode` | `PaymasterFeeMode`       | no       | Who pays the gas. Defaults to `{ mode: "sponsored" }` (the service pays).      |

`feeMode` is either `{ mode: "sponsored" }` (the service pays, requires a sponsorship deal)
or `{ mode: "default"; gasToken: string; maxFeeInGasToken: bigint }` (the account repays the
service in `gasToken`, capped by `maxFeeInGasToken`). See `@starkware-libs/anystark-core` for the full
fee-mode semantics and the signing guard that enforces the cap.

**`signingLabel`** prefixes the base64 message hash in every signed message so the Phantom
popup shows the user a readable line instead of an opaque blob. It is bounded to 258 UTF-8
bytes and is rejected before signing if longer. Keep it a short single sentence: the account
re-hashes the whole message on every validation, so a longer label costs an extra SHA-512
block (roughly +5.3M gas) on every transaction. See `@starkware-libs/anystark-core` for the exact
byte-budget and gas breakdown.

The label is advisory: the chain verifies only the hash, never the text. Control, invisible,
and text-reordering codepoints are rejected before signing, but a combining mark at the start
of interpolated text can still restyle the character before it, so sanitize third-party
strings (token names, order notes) before splicing them into a label.

Use a plain string for one static label. For a per-action label, pass a `LabeledExecutor`
(also re-exported from `@starkware-libs/anystark-react`): the pending label is set only by
`execute()` itself, resolved and cleared at sign time, and calls are serialized, so a label
can never leak to a later or concurrent call's signature. There is no public `set()` to
misuse:

```ts
const labeledExecutor = new LabeledExecutor("MyApp"); // default label when execute() gets none

new PhantomConnector({ ...config, signingLabel: labeledExecutor });

// action handler: label and calls come from the same variables.
export async function withdraw(account: AccountInterface, amount: bigint, dest: string) {
  const calls = buildWithdrawCalls(amount, dest);
  const label = `MyApp: withdraw ${formatUsdc(amount)} USDC to ${shorten(dest)}`;
  // Omit the label argument to sign with the default ("MyApp"); pass '' for the bare hash.
  return labeledExecutor.execute(account, calls, label);
}
```

`LabeledExecutor` holds one invariant: **every** `execute()` on the connected account must go
through the instance. A direct `account.execute()` issued while the executor is idle now fails
at sign time with a descriptive error, instead of signing under a wrong or default label; one
that overlaps a labeled call in flight is still shown that call's label undetected. See the
class doc in `@starkware-libs/anystark-core` for the rest of the contract (not reentrant, no
timeout, await the returned promise).

## Connector behavior

`PhantomConnector` extends `@starknet-react/core`'s `Connector`:

| Member               | Value / behavior                                                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                 | `"phantomEwc"`. Use it to find the connector in the `connectors` array.                                                                                                    |
| `name`               | `"Phantom"`.                                                                                                                                                               |
| `icon`               | A data-URI placeholder mark (Phantom purple). Swap for the official brand asset in your UI if you prefer.                                                                  |
| `available()`        | `boolean`. `true` when Phantom is injected at `window.phantom.solana`.                                                                                                     |
| `ready()`            | `Promise<boolean>`. Silently restores an existing authorization (via `onlyIfTrusted`) without prompting, so `autoConnect` does not pop the Phantom dialog on every load.   |
| `connect()`          | Resolves to `{ account, chainId }`, builds the sponsored `SolanaAsStarknetAccount`, and emits a `connect` event.                                                           |
| `disconnect()`       | Clears connector state and emits a `disconnect` event.                                                                                                                     |
| `account(provider?)` | `Promise<AccountInterface>`. Returns the `SolanaAsStarknetAccount` pinned to `starknetRpcUrl`. If a provider is passed, it guards against a chain-id mismatch (see above). |
| `chainId()`          | `Promise<bigint>`. Returns `config.chainId` if set, otherwise one memoized `getChainId()` RPC.                                                                             |
| `request(call)`      | Throws. The wallet-request API is not implemented; send transactions through the connected account instead.                                                                |

Because `account()` returns a starknet.js `Account` subclass, any `AccountInterface`
consumer (a `useSendTransaction` hook, a contract call, `account.execute(...)`) runs the
sponsored, deploy-on-first-use flow with no special casing. To send transactions, use the
connected account through the standard hooks or `account.execute(...)`; `request()` is
unsupported and throws.

## Derivation helpers

The derivation helpers are re-exported from `@starkware-libs/anystark-react`, so a dapp can derive a
user's counterfactual `sol_account` address (for example to display it, or to pre-fund it
before deploy) with only this package as a dependency:

```ts
import { deriveSolAccountAddress, resolveDeployClassHash } from "@starkware-libs/anystark-react";

const classHash = resolveDeployClassHash({ chainId }); // frozen deploy hash for the chain
const { address } = deriveSolAccountAddress(pubkey32, classHash);
```

`resolveDeployClassHash` returns the frozen `deploy` class hash the counterfactual address
is derived from. `deriveSolAccountAddress` takes the raw 32-byte Ed25519 public key plus
that class hash and returns the derivation (including `address`). The `ChainId` and
`SolAccountDerivation` types are re-exported too.

## Testing (`@starkware-libs/anystark-react/testing`)

The `@starkware-libs/anystark-react/testing` subpath is a browser-free test double so you can drive the full
connect and sign flow in unit tests with no extension and no browser globals. It is a
separate bundle entry, so none of it lands in your app's runtime bundle.

| Export                 | What it is                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------- |
| `MockPhantomConnector` | A `PhantomConnector` wired to an in-memory provider instead of the browser extension.                    |
| `MockPhantomProvider`  | An in-memory `window.phantom.solana`, backed by the canonical deterministic test key.                    |
| `installMockPhantom`   | Installs a `MockPhantomProvider` at `window.phantom.solana` for the discovery path.                      |
| `MOCK_PHANTOM_PUBKEY`  | The mock wallet's 32-byte Ed25519 public key (equals `@starkware-libs/anystark-core`'s `LOCKED_PUBKEY`). |

```ts
import { expect, it } from "vitest";
import { CHAIN_IDS } from "@starkware-libs/anystark-core";
import { MockPhantomConnector } from "@starkware-libs/anystark-react/testing";

it("connects offline", async () => {
  const connector = new MockPhantomConnector({
    starknetRpcUrl: "http://localhost:5050",
    chainId: CHAIN_IDS.sepolia,
    paymaster: { nodeUrl: "http://paymaster.localhost" },
  });
  const { account } = await connector.connect();
  expect(account).toMatch(/^0x/);
});
```

`MockPhantomConnector`'s constructor accepts an optional second argument, a
`MockPhantomProvider`, and exposes it as the readonly `mockProvider` field so a test can
inspect or drive it. When omitted, it constructs a fresh one.

### Simulating wallet events

`MockPhantomProvider` implements the injected provider surface (`connect` / `disconnect` /
`publicKey` / `signMessage` / `on` / `removeListener`) and adds a test-only
`emit(event, ...args)` so you can fire Phantom's `connect` / `disconnect` / `accountChanged`
events and exercise the `on` / `removeListener` subscription round-trip:

```ts
import { MockPhantomProvider } from "@starkware-libs/anystark-react/testing";

const provider = new MockPhantomProvider();
const seen: unknown[] = [];
provider.on("accountChanged", (pubkey) => seen.push(pubkey));
provider.emit("accountChanged", null); // synchronously invokes the handler
```

`signMessage` Ed25519-signs the exact bytes it is handed and never constructs or inspects
the message encoding, so it stays correct regardless of how the signed message is formed
upstream. `signAndSendTransaction` throws: it is the Solana CCTP path, outside the
`sol_account` flow.

### `installMockPhantom` and `uninstall()`

Use `installMockPhantom()` when you specifically want to exercise the window-discovery path
of a plain `PhantomConnector` (its `available()`), rather than injecting a provider
explicitly:

```ts
import { installMockPhantom } from "@starkware-libs/anystark-react/testing";
import { PhantomConnector } from "@starkware-libs/anystark-react";
import { CHAIN_IDS } from "@starkware-libs/anystark-core";

const { provider, uninstall } = installMockPhantom();
const connector = new PhantomConnector({
  starknetRpcUrl: "http://localhost:5050",
  chainId: CHAIN_IDS.sepolia,
  paymaster: { nodeUrl: "http://paymaster.localhost" },
});
expect(connector.available()).toBe(true);
uninstall(); // restores window.phantom to exactly its prior state
```

It is surgical: it sets only `window.phantom` (creating a bare `window` first if none
exists), and `uninstall()` restores exactly what it changed. It puts back the previous
`phantom` value (or deletes the key if there was none), or removes the whole `window` object
if it created that.

### Offline `chainId` caveat

`MockPhantomConnector` requires `chainId` in its config. The base connector resolves the
chain id from a live `getChainId()` RPC when `chainId` is absent, which would turn an
ostensibly offline test into a network call. To keep tests fully offline the mock
constructor throws if `chainId` is omitted, so always pass one (for example
`CHAIN_IDS.sepolia`).
