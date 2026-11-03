# @starkware-libs/anystark-paymaster-proxy

> ⚠️ **Unaudited code. Use at your own risk.**
>
> This code has not been audited or fully tested and may contain bugs or security vulnerabilities. It is provided “as is” without warranty of any kind. Do not use it in production or with real funds unless you have reviewed and tested it yourself.

A thin, **stateless** SNIP-29 paymaster sponsorship proxy. Paste your upstream
paymaster API key, set a sponsorship policy, deploy, and point your SDK at it.

> This package publishes to npm as `@starkware-libs/anystark-paymaster-proxy`,
> alongside `@starkware-libs/anystark-core`, `@starkware-libs/anystark-cctp`, and
> `@starkware-libs/anystark-react`. It ships both a deployable proxy (serverless functions
> or a worker) and a library surface. It is **provider-agnostic**: any SNIP-29-compatible
> upstream paymaster works; the upstream URL and API key are configured via environment
> variables.

## Installation

```bash
npm install --save-exact @starkware-libs/anystark-paymaster-proxy
```

`@starkware-libs/anystark-core` is a direct dependency, so it is always installed with the
proxy.

**Pin exact versions.** The proxy fronts the upstream paymaster API key path, so
supply-chain caution warrants exact pins: install with an exact version (for example
`npm install --save-exact`, or set `save-exact=true` in your `.npmrc`) so the manifest
records an exact version, and review upgrades deliberately before adopting them.

## What it is

starknet.js talks to a paymaster via `PaymasterRpc({ nodeUrl })`. Pointing that
directly at a hosted paymaster means shipping your secret API key to the
frontend, where anyone can lift it and sponsor arbitrary transactions on your
gas budget.

This proxy sits in between. The SDK points `PaymasterRpc` at **this proxy**
instead of the upstream paymaster. The proxy:

1. **Keeps the API key server-side.** The secret is read from
   `PAYMASTER_API_KEY` and injected as the `x-paymaster-api-key` header on the
   way upstream. It never appears in any response.
2. **Enforces a sponsorship policy on build AND execute.** On both
   `paymaster_buildTransaction` and `paymaster_executeTransaction`, every call
   must target an allowlisted `(contract, selector)` and every deployed class
   hash must be in your sponsored list. `executeTransaction` is the call that
   actually spends gas, so the allowlist is extracted from the signed SNIP-9/
   SNIP-12 typed data (`transaction.invoke.typed_data.message`) and
   re-checked there too. Anything else is rejected with a JSON-RPC error before
   it ever reaches the upstream paymaster.
3. **Forces sponsored fee mode.** Client-supplied `fee_mode` is never trusted:
   it is overridden to the policy's mode (default `{ mode: "sponsored" }`) and
   any client `tip` is stripped (or clamped to `maxTip`).
4. **Rate-limits per account and enforces a global budget cap**, fail-closed on
   a durable store (Upstash Redis).
5. **Forwards everything else verbatim** (`paymaster_isAvailable`,
   `paymaster_getSupportedTokens`, `paymaster_trackingIdToLatestHash`).

### Provider-agnostic

The proxy is **not tied to AVNU**. It forwards plain SNIP-29 JSON-RPC to
whatever `PAYMASTER_UPSTREAM_URL` points at: an AVNU hosted endpoint
(`https://sepolia.paymaster.avnu.fi`, `https://starknet.paymaster.avnu.fi`) or
your own self-hosted SNIP-29 instance.

## Environment variables

| Variable                   | Required    | Description                                                                          |
| -------------------------- | ----------- | ------------------------------------------------------------------------------------ |
| `PAYMASTER_API_KEY`        | yes         | Secret upstream API key. Injected as `x-paymaster-api-key`.                          |
| `PAYMASTER_UPSTREAM_URL`   | no          | Upstream SNIP-29 endpoint. Defaults to `https://sepolia.paymaster.avnu.fi`.          |
| `PAYMASTER_POLICY`         | yes         | Sponsorship policy as a JSON string (see below).                                     |
| `UPSTASH_REDIS_REST_URL`   | conditional | Upstash Redis REST URL. Required when `rateLimit`/`globalCap` is set (see Security). |
| `UPSTASH_REDIS_REST_TOKEN` | conditional | Upstash Redis REST token.                                                            |

See [`.env.example`](./.env.example).

## Policy JSON shape

**Generate this with the policy generator instead of writing it by hand.** You
pass contract addresses and plain function names (not raw felt selectors), and it
computes the `sn_keccak` selectors, builds the policy, validates it through the
proxy's real parser, and prints an env-ready one-line `PAYMASTER_POLICY`. See
[Policy generator CLI](#policy-generator-cli) for the full flag reference, the
interactive wizard, the fail-closed acknowledgment model, and worked examples.

The shape it produces (kept here as a reference for the fields):

```jsonc
{
  // Calls eligible for sponsorship. Omit `selectors` to allow any selector on `to`.
  "allowedCalls": [
    {
      "to": "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
      "selectors": ["0x0083afd3f4caedc6eebf44246fe54e38c95e3179a5ec9ea81740eca5b482d12e"],
    },
  ],
  // Class hashes whose counterfactual deployment may be sponsored. The generator
  // always pins this to the AnyStark account `deploy` class hash for the chosen
  // chain (sepolia shown here).
  "sponsoredClassHashes": ["0x07ec6a68af00a71582569f94ee3ec85eb530365a06b6b7cefbef8f2f8f6c2288"],
  // Optional per-account rate limit (keyed by user/deploy address).
  "rateLimit": { "maxPerAddress": 20, "windowSec": 3600 },
  // Optional global budget cap across ALL addresses (sybil-resistant).
  "globalCap": { "maxPerWindow": 5000, "windowSec": 3600 },
  // Optional forced fee mode. Defaults to { "mode": "sponsored" }.
  "feeMode": { "mode": "sponsored" },
  // Optional: clamp a numeric client tip to this u64. Omit entirely to strip
  // every client tip (the default). Note: maxTip:0 is NOT the same as omitting
  // it; 0 only clamps numeric/custom tips to 0, whereas omitting strips all
  // tip forms (including string priorities).
  "maxTip": 1000,
  // LOCAL/TEST ONLY: disables the fail-closed durable-store guard. Never set true in prod.
  "allowInMemoryStore": false,
}
```

Felts are compared canonically, so `0x04` and `0x4` are treated as equal. Two `allowedCalls` entries whose `to` is the same canonical address are rejected when the policy is first loaded (a 500 on the first request, with the offending entries named in the proxy's logs), so merge them into a single entry with a deduped selector union (or keep exactly one bare entry for any-selector); the policy generator (see below) does this merging for you.

## Policy generator CLI

`scripts/generate_policy.mjs` turns contract addresses plus plain function names
plus plain-language limits into a validated, env-ready one-line `PAYMASTER_POLICY`.
It computes the `sn_keccak` selectors for you, builds the policy, and round-trips
the result through the proxy's real `configFromEnv`, so it can never emit a string
the proxy would reject at deploy time.

As a consumer of the published package, run it through the `anystark-paymaster-policy` bin:

```sh
npx --package @starkware-libs/anystark-paymaster-proxy anystark-paymaster-policy <flags>
```

In this monorepo, run it through the workspace script:

```sh
npm run -w @starkware-libs/anystark-paymaster-proxy policy -- <flags>
```

### Prerequisites

The published package ships prebuilt output, so an installed consumer runs the generator with
no build step: the `anystark-paymaster-policy` bin resolves the pinned AnyStark `deploy` class
hash from the installed `@starkware-libs/anystark-core` and round-trips through the proxy's own
compiled parser.

In this monorepo the generator reads both from `dist`, so build core and the proxy first:

```sh
npm run -w @starkware-libs/anystark-core build              # pinned AnyStark deploy class hash is read from the core dist
npm run -w @starkware-libs/anystark-paymaster-proxy build   # the generator round-trips through the built parser
```

If either dist is missing in the monorepo, the generator exits with an actionable "build the
package first" message rather than a raw import error.

### Flags

| Flag                                       | Description                                                                                                                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--call <address>[:<fn1>,<fn2>,...]`       | Allowlist calls to `<address>` (repeatable). With a function list, only those selectors are allowed. Omit the `:` and list to allow ANY selector (broad; requires `--allow-any-selector`). |
| `--allow-any-selector`                     | Acknowledge any bare `--call` (any-selector) entry.                                                                                                                                        |
| `--rate-limit <maxPerAddress>/<windowSec>` | Per-account rate limit, e.g. `20/3600`. Two positive integers.                                                                                                                             |
| `--global-cap <maxPerWindow>/<windowSec>`  | Global budget cap across ALL addresses, e.g. `5000/3600`. Two positive integers.                                                                                                           |
| `--allow-unbounded-budget`                 | Acknowledge a policy that sets neither `rateLimit` nor `globalCap`.                                                                                                                        |
| `--chain <name\|chainId>`                  | Chain whose pinned AnyStark `deploy` class hash is sponsored. Accepts a name (`sepolia`) or a raw chainId felt. Default `sepolia`.                                                         |
| `--pretty`                                 | Also print an indented copy of the policy for review (set the one-line form, not this).                                                                                                    |
| `-h`, `--help`                             | Print the usage message.                                                                                                                                                                   |

Unknown flags, a flag missing its value, or a malformed `--rate-limit` /
`--global-cap` / `--chain` value all exit non-zero with the usage text.

**`--call` spec grammar.** The address is everything before the first `:`; an
optional comma-separated function list follows. Repeating the same address with
function lists **merges** (unions and dedupes) the selectors into one entry,
because the proxy keys its allowlist on the canonical address. A trailing `:` with
no function names (`addr:`, `addr:,`) is a hard error rather than a silent widening
to any-selector. Giving one address **both** a bare (any-selector) form and a
function-list form is a contradiction and errors, since the proxy would keep only
one; list every allowed function in a single `--call addr:fn1,fn2`, or use a single
bare `--call addr`.

**Mandatory sponsored deploy class hash.** `sponsoredClassHashes` is always the
pinned AnyStark account `deploy` class hash for the chosen chain, and there is no
flag to change or drop it. A first-touch user's counterfactual AnyStark account is
deployed as part of their first sponsored transaction, so sponsoring that class is
mandatory. The account derives to the same address across every dapp that
integrates AnyStark, so its creation is sponsored at most once per user: a
returning user who already deployed it elsewhere incurs no further creation cost.
On sepolia this is `0x07ec6a68af00a71582569f94ee3ec85eb530365a06b6b7cefbef8f2f8f6c2288`.
A chain with no pinned AnyStark class hash is rejected with an actionable error
naming the supported chains.

### Fail-closed acknowledgment model

The generator **refuses to emit a paste-ready string** for a dangerous-but-legitimate
policy unless you opt in with the matching flag, rather than printing it with a
warning that a `... > policy.env` redirect would scroll past unseen:

- A bare `--call <address>` (any selector on that contract) requires `--allow-any-selector`.
- A policy that sets neither `rateLimit` nor `globalCap` (an unbounded budget) requires `--allow-unbounded-budget`.

Without the matching acknowledgment the generator exits non-zero and names both the
offending value and the flag to add. The interactive wizard applies the same gate
as a per-condition `[y/N]` confirmation that defaults to abort.

### Output

The generator echoes each `functionName -> selector` mapping to stderr so you can
catch a typo (`trasnfer`) before shipping, prints any non-fatal warnings to stderr,
then prints the one-line `PAYMASTER_POLICY` (and, with `--pretty`, an indented copy)
to stdout. Splitting the mapping and warnings to stderr keeps a `... > policy.env`
stdout redirect paste-clean. It never sets `allowInMemoryStore` and never prints the
upstream API key or any other secret.

### Interactive wizard

Run the generator with no arguments on a TTY for an interactive wizard that asks the
same questions one at a time (contract addresses and functions, chain, per-user rate
limit, global cap), applies the same fail-closed confirmations, and prints the same
output. With no arguments and no TTY it prints usage to stderr and exits non-zero
rather than emitting an empty-allowlist policy.

### Examples

A selector-scoped ERC-20 policy (sponsor only `transfer` and `approve` on one token),
per-account and global limits:

```sh
npm run -w @starkware-libs/anystark-paymaster-proxy policy -- \
  --call 0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7:transfer,approve \
  --rate-limit 20/3600 --global-cap 5000/3600
```

A cross-package policy that also sponsors [`@starkware-libs/anystark-cctp`](../cctp/) (BETA) bridge
calls: `receive_message` on the Starknet MessageTransmitter (minting bridged USDC on
deposit), plus `approve` on the USDC token and `deposit_for_burn` on the TokenMessenger
(the two calls a Solana-bound withdrawal makes). The addresses below are the
`CCTP_TESTNET_CONFIG` Sepolia values; read them off your own `CctpConfig`:

```sh
npm run -w @starkware-libs/anystark-paymaster-proxy policy -- \
  --call 0x04db7926C64f1f32a840F3Fa95cB551f3801a3600Bae87aF87807A54DCE12Fe8:receive_message \
  --call 0x0512feAc6339Ff7889822cb5aA2a86C848e9D392bB0E3E237C008674feeD8343:approve \
  --call 0x04bDdE1E09a4B09a2F95d893D94a967b7717eB85A3f6dEcA8c080Ee01fBc3370:deposit_for_burn \
  --rate-limit 20/3600 --global-cap 5000/3600
```

A bare any-selector entry needs its acknowledgment flag, otherwise the generator
exits non-zero:

```sh
npm run -w @starkware-libs/anystark-paymaster-proxy policy -- \
  --call 0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7 \
  --allow-any-selector --global-cap 5000/3600
```

## Deploy

The Vercel and Cloudflare adapters ship in the published package under `adapters/` as source
templates; their documented deploy flows below (a Vercel project Root Directory, a `wrangler`
entry point) run from a checkout of this repository. An npm consumer deploying to a fetch
runtime uses the published `@starkware-libs/anystark-paymaster-proxy/node` factory instead
(see the Node / Hono / Bun / Deno section below).

### Vercel

The serverless function lives at
[`adapters/vercel/api/paymaster.ts`](./adapters/vercel/api/paymaster.ts).

> **Required:** Vercel's filesystem routing only exposes `api/*` relative to the
> project **Root Directory**. Set the Vercel project's Root Directory to
> `packages/paymaster-proxy/adapters/vercel` so the function is served at
> `/api/paymaster`. Without this the route silently 404s.

Set `PAYMASTER_API_KEY`, `PAYMASTER_UPSTREAM_URL`, and `PAYMASTER_POLICY` (plus
the Upstash vars if you configure a rate limit / global cap) in the project's
Environment Variables, then deploy. Point
`PaymasterRpc({ nodeUrl: "https://<your-app>.vercel.app/api/paymaster" })`.

### Cloudflare Workers

The worker lives at
[`adapters/cloudflare/worker.ts`](./adapters/cloudflare/worker.ts). Configure
`wrangler` with that as the entry point, set the same vars as Worker secrets /
vars (`wrangler secret put PAYMASTER_API_KEY`, etc.), and `wrangler deploy`.

### Node / Hono / Bun / Deno (fetch handler)

For any runtime that speaks the Web Fetch API (Cloud Run, Node 20+, Bun, Deno,
Hono, Fastify), the [`adapters/node`](./adapters/node/) adapter exports a
`createPaymasterProxyHandler(env?)` factory that returns a standard
`(request: Request) => Promise<Response>` handler. Import it from the
`@starkware-libs/anystark-paymaster-proxy/node` subpath, set the same env vars as the other
adapters, and mount it however your runtime mounts a fetch handler. See
[`adapters/node/README.md`](./adapters/node/README.md) for Hono / Bun / Deno
snippets.

## Pairing with the AnyStark SDK

Once deployed, point the SDK at the proxy URL wherever it takes a paymaster. A
paymaster is REQUIRED across the SDK (execution is sponsored-only), so the proxy
URL goes straight into the `paymaster.nodeUrl` field. The proxy holds the upstream
key and enforces the policy, so nothing secret ships to the frontend.

With `@starkware-libs/anystark-react` (`PhantomConnectorConfig`):

```ts
import { PhantomConnector, type PhantomConnectorConfig } from "@starkware-libs/anystark-react";

const config: PhantomConnectorConfig = {
  starknetRpcUrl: "https://your-starknet-rpc.example",
  chainId: "0x534e5f5345504f4c4941", // SN_SEPOLIA
  paymaster: { nodeUrl: "https://<your-app>.vercel.app/api/paymaster" },
};

const connector = new PhantomConnector(config);
```

With `@starkware-libs/anystark-core` (`CreateSolanaAccountParams`):

```ts
import { SolanaAsStarknetAccount, resolveDeployClassHash } from "@starkware-libs/anystark-core";

const account = new SolanaAsStarknetAccount({
  signer, // a SolanaSigner backed by the connected wallet
  rpcUrl: "https://your-starknet-rpc.example",
  classHash: resolveDeployClassHash({ chainId: "0x534e5f5345504f4c4941" }),
  paymaster: { nodeUrl: "https://<your-app>.vercel.app/api/paymaster" },
});
```

The proxy forces sponsored fee mode regardless of what the client sends, so leave
`paymaster.feeMode` at its `sponsored` default. `account.execute(calls)` (and the
first-use counterfactual deploy, and a sponsored `account.upgrade(classHash)`) then
route through the proxy, which sponsors only the calls your policy allowlists.

## Rate limiting & durable store (fail-closed)

The built-in `InMemoryRateLimitStore` only counts within a single instance.
Serverless/edge platforms spin up many short-lived isolates, so in those
environments it does **not** enforce a global limit.

To enforce limits durably, set `UPSTASH_REDIS_REST_URL` and
`UPSTASH_REDIS_REST_TOKEN`. `configFromEnv` then auto-wires a
`RedisRateLimitStore` (Upstash Redis over its REST API via `fetch`, no extra
dependency) shared across all isolates.

**Fail-closed:** if the policy configures `rateLimit` or `globalCap` but no
durable store is available, the proxy **refuses to operate**: `configFromEnv`
throws (adapters return a 500) and the handler denies sponsoring requests with a
JSON-RPC error. The only way to run limits on the in-memory store is to set
`"allowInMemoryStore": true` in the policy, which is intended for **local/test
use only**. Store errors (Redis unreachable) also fail closed: the request is
denied, never forwarded.

### Counting semantics

Limits count sponsoring **RPC calls**, not completed sponsorships. A normal flow
is `paymaster_buildTransaction` followed by `paymaster_executeTransaction`, i.e.
TWO calls against the same per-account key and the same global counter, so one
completed sponsorship consumes about **2 slots**. Counting also happens BEFORE the
upstream forward, so a request the upstream later rejects still spends a slot. Size
`maxPerAddress` / `maxPerWindow` accordingly: to permit N completed flows, set the
counts to roughly `2 * N`. The per-account limit is checked before the global cap,
so a per-account denial never spends a global slot.

## Security

- **Execute-path enforcement.** The sponsorship allowlist (and the forced fee
  mode) is enforced on `paymaster_executeTransaction` (the call that actually
  spends gas), not only on `paymaster_buildTransaction`. Execute-path calls are
  extracted from the signed SNIP-9/SNIP-12 outside-execution typed data at
  `transaction.invoke.typed_data.message`, so a client cannot get a benign
  transaction built and then submit a different one for execution. The V1/V2
  form comes from the signed `typed_data.domain` (V2 `Calls` with
  `To`/`Selector`, V1 `calls` with `to`/`selector`), and only that form's field
  names are read, so unsigned fields in the other casing are ignored. A message
  with both `Calls` and `calls`, or an unrecognized domain version, is rejected.
- **Forced sponsored fee / stripped tips.** Client-supplied `fee_mode` is never
  trusted. It is overridden to the policy's mode (default `sponsored`); a client
  gas-token mode is overridden to sponsored rather than rejected. Client tips are
  stripped by default (or clamped to `maxTip`) so a leaked frontend cannot inflate
  your cost via tips.
- **Fail-closed durable rate limit + global cap.** Per-address `rateLimit` and a
  single shared `globalCap` counter both run on the execute path. Without a
  durable store (or on store error) the proxy denies rather than silently
  un-limiting. With `rateLimit` set, a request that carries no account address
  is rejected. On `deploy_and_invoke`, `invoke.user_address` and
  `deployment.address` must name the same account.
- **Sybil warning.** Per-address rate limits are **bypassable by address churn**
  (an attacker can mint fresh addresses). The `globalCap` bounds total sponsored
  ops regardless of address, but it does not distinguish attackers from real
  users. **For production you should run the `globalCap` AND an external
  anti-sybil layer** (captcha, per-IP limiting at the edge / WAF, account
  attestation). The proxy cannot see client IPs reliably, so per-IP limiting
  belongs in front of it.
- **Startup version-skew guard.** At the adapter bootstrap the proxy asserts that
  `PAYMASTER_POLICY.sponsoredClassHashes` includes the deploy class hash pinned by the
  installed `@starkware-libs/anystark-core`. On a mismatch it fails closed (the adapters
  return the generic misconfigured 500) rather than silently denying every first-touch
  account deployment the frontend SDK produces. The check is presence, not exact equality,
  so a policy that also sponsors additional class hashes passes.
- **Malformed input.** Malformed or out-of-range felts (e.g. `"0xZZ"`, `"0x"`),
  execute typed data with both `Calls` and `calls`, without the signed form's
  key, or with an unrecognized domain, a `deploy_and_invoke` whose two account
  addresses differ, and a missing account address under `rateLimit` are rejected
  as JSON-RPC `INVALID_PARAMS` (-32602), never surfaced as an uncaught 500.
- **Key handling.** The upstream API key is read from the environment only,
  injected as a header, and never echoed in any response; client headers are not
  forwarded; batch requests are rejected.

### Relayer fee-at-risk

Sponsored execution means the upstream paymaster pays the on-chain gas for a user's
signed call set. A call set can pass off-chain simulation and still revert on-chain (a
front-run state change, block-dependent logic), and the relayer pays the gas of that
reverted transaction while the SNIP-9 nonce rolls back. This is inherent to SNIP-9
outside execution on current Starknet: an account cannot catch an inner-call panic
on-chain (`SafeDispatcher` error catching works only under test cheat infrastructure), and
the exposure is shared by every SNIP-9 account (OpenZeppelin, Argent, Braavos), not
specific to the AnyStark account. The allowlist and the caps here bound _which_ calls and
_how many_ are sponsored; they do not make a sponsored call's on-chain success certain.

Standard operator mitigations, layered on top of the policy above:

- Simulate at a pending block close to submission time, so the simulation sees state near
  what the transaction executes against.
- Cap per-transaction resources (gas and fee bounds) so a single reverted or out-of-gas
  call cannot drain an outsized share of the budget.
- Rate-limit and deny-list senders: the `rateLimit` / `globalCap` above, plus the external
  anti-sybil layer from the Sybil warning, since per-address limits are bypassable by
  address churn.
- Monitor failed sponsored transactions and alert on a rising revert rate, the signal of
  active griefing.

## JSON-RPC surface

The proxy speaks JSON-RPC 2.0 and handles one request per call; a batch (a JSON
array body) is rejected as `Invalid Request`. Five SNIP-29 methods are forwarded;
any other method is rejected as `Method not found`.

| Method                             | Handling                                                                                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `paymaster_buildTransaction`       | Sponsoring. Policy checked against `transaction.invoke.calls`; rate limit + global cap applied; fee mode forced and tips stripped/clamped; then forwarded.      |
| `paymaster_executeTransaction`     | Sponsoring. Policy checked against the calls in the SIGNED `typed_data.message` (never client `invoke.calls`); limits applied; fee mode forced; then forwarded. |
| `paymaster_getSupportedTokens`     | Forwarded verbatim with the upstream key injected.                                                                                                              |
| `paymaster_isAvailable`            | Forwarded verbatim with the upstream key injected.                                                                                                              |
| `paymaster_trackingIdToLatestHash` | Forwarded verbatim with the upstream key injected.                                                                                                              |

Every application-level outcome, denials included, is returned with HTTP 200 and a
JSON-RPC error body (the HTTP transport succeeded, the RPC call did not). The
standard and application error codes:

| Code     | Name             | Returned when                                                                                                           |
| -------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `-32700` | Parse error      | the request body is not valid JSON.                                                                                     |
| `-32600` | Invalid Request  | the body is not a JSON-RPC object, or is a batch array.                                                                 |
| `-32601` | Method not found | the method is outside the five-method SNIP-29 allowlist.                                                                |
| `-32602` | Invalid params   | the transaction or its `type` is missing, or the request is malformed (see **Malformed input** above).                  |
| `-32603` | Internal error   | the upstream request failed or returned a non-2xx / non-JSON response (upstream internals never leak through).          |
| `-32010` | `POLICY_DENIED`  | a call targets a non-allowlisted `(contract, selector)`, or a deployed class hash is not in `sponsoredClassHashes`.     |
| `-32011` | `RATE_LIMITED`   | a per-account limit or the global cap is exceeded, a limit is configured without a durable store, or the store errored. |

On top of this wire contract the adapters add transport-level statuses: a non-POST
request gets HTTP 405 and a misconfiguration or unexpected runtime error gets a
generic HTTP 500 (no message, stack, key, or upstream URL in the body). See
[`adapters/node/README.md`](./adapters/node/README.md) for those semantics.

## Library API

Deploying an adapter is the common path. To embed the proxy directly in your own
server (any framework), import the framework-agnostic core from
`@starkware-libs/anystark-paymaster-proxy`:

```ts
import {
  assertCoreDeployClassHashSponsored,
  configFromEnv,
  handlePaymasterRequest,
} from "@starkware-libs/anystark-paymaster-proxy";

const config = configFromEnv(process.env);
// Fail closed at startup on a policy/core version skew. The adapters run this for you; an
// embedder should run it right after configFromEnv. It throws with an actionable message
// when the policy does not sponsor the deploy class hash pinned by the installed
// @starkware-libs/anystark-core.
assertCoreDeployClassHashSponsored(config.policy);

// inside your POST handler (Express shown; any framework works):
const { status, body } = await handlePaymasterRequest(await req.text(), config);
res.status(status).json(body); // status is 200 even for policy / rate-limit denials
```

For a ready-made Web fetch handler instead of wiring `handlePaymasterRequest`
yourself, use the [`@starkware-libs/anystark-paymaster-proxy/node`](./adapters/node/README.md)
subpath's `createPaymasterProxyHandler(env?)`.

### `handlePaymasterRequest(rawBody, config)`

`handlePaymasterRequest(rawBody: string | object, config: ProxyConfig): Promise<{ status: number; body: object }>`.
The core pipeline: parse the JSON-RPC envelope, reject non-allowlisted methods and
batches, enforce policy + limits (fail closed), force sponsored fee mode and
strip/clamp tips, then forward to the upstream with the key injected. `rawBody`
accepts a raw JSON string or an already-parsed object (some platforms parse the
body for you). The returned `status` is 200 for successes and application errors
alike; only the adapters map transport problems to non-200.

### `ProxyConfig`

```ts
interface ProxyConfig {
  upstreamUrl: string; // upstream SNIP-29 paymaster URL (AVNU hosted or self-hosted)
  apiKey: string; // secret upstream key, injected as the x-paymaster-api-key header
  policy: SponsorshipPolicy;
  store?: RateLimitStore; // defaults to an in-memory store (single instance only)
}
```

### `configFromEnv(env)` and `ProxyEnv`

`configFromEnv(env: ProxyEnv): ProxyConfig` builds the full config (store included)
from environment variables, throwing loudly on any misconfiguration so a bad
deployment fails fast rather than silently sponsoring the wrong thing. `ProxyEnv`
carries `PAYMASTER_API_KEY?`, `PAYMASTER_UPSTREAM_URL?`, and `PAYMASTER_POLICY?`,
and extends `UpstashEnv`. It throws when:

- `PAYMASTER_API_KEY` is missing.
- `PAYMASTER_POLICY` is missing, is not valid JSON, or lacks `allowedCalls[]` / `sponsoredClassHashes[]`.
- any felt in the policy (an allowlist target or selector, or a class hash) is malformed or out of field range.
- two `allowedCalls` entries resolve to the same canonical target address.
- a `rateLimit` / `globalCap` is configured but no durable store is available and `allowInMemoryStore` is not set.

When `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` are present it auto-wires
a `RedisRateLimitStore`.

### `assertCoreDeployClassHashSponsored(policy)`

`assertCoreDeployClassHashSponsored(policy: SponsorshipPolicy): void` asserts that the policy
sponsors the deploy class hash pinned by the installed `@starkware-libs/anystark-core`,
throwing an actionable error naming both sides when it does not. The adapters call it at
bootstrap; call it yourself right after `configFromEnv` when you embed the library directly,
so a policy/core version skew fails closed at startup instead of silently denying every
account deployment the frontend SDK produces. The check is presence (at least one pinned core
hash is sponsored), not exact equality, so a policy that sponsors additional class hashes
passes.

### Rate-limit stores

- `interface RateLimitStore { hit(key: string, windowSec: number): Promise<number> }` records one hit against `key` within a sliding `windowSec` window and returns the running count. **Fail-closed contract:** a custom store MUST throw to deny; the handler treats any throw from `hit` as "deny, do not forward".
- `class InMemoryRateLimitStore` is the default store. It counts within a single instance only, so it does not enforce across serverless / edge isolates; the handler fails closed when a limit is configured with only this store (unless `allowInMemoryStore` is set).
- `class RedisRateLimitStore` is the durable store over the Upstash Redis REST API (an `INCR` + `EXPIRE NX` pipeline using `fetch` only, no extra dependency). `new RedisRateLimitStore(url, token)` throws on an empty url or token. `RedisRateLimitStore.fromEnv(env: UpstashEnv)` returns a store, or `undefined` when either var is missing. Its `hit` throws on any non-OK HTTP status or malformed response so enforcement fails closed.
- `interface UpstashEnv { UPSTASH_REDIS_REST_URL?: string; UPSTASH_REDIS_REST_TOKEN?: string }`.

A custom store implements the fail-closed contract itself:

```ts
import { type RateLimitStore } from "@starkware-libs/anystark-paymaster-proxy";

class MyStore implements RateLimitStore {
  async hit(key: string, windowSec: number): Promise<number> {
    // increment `key` within a `windowSec` window and return the running count.
    // THROW on any backend error so the handler fails closed (denies the request).
    return 1;
  }
}
```

### Policy-evaluation helpers

Reuse the exact allowlist logic outside the request pipeline (e.g. to pre-check a
transaction before submitting it, or in tests):

- `normalizeFelt(value: string): string` returns the canonical felt form (lowercase `0x`, no leading zeros, so `0x04` equals `0x4`); throws `InvalidFeltError` on a non-felt or out-of-field value.
- `class InvalidFeltError` is thrown by `normalizeFelt` (and by `extractTargets` for a
  malformed `deploy_and_invoke` account address); the handler maps it to `INVALID_PARAMS`
  (`-32602`).
- `class InvalidOutsideExecutionError` and `class ConflictingAccountAddressError` are
  thrown by `extractTargets` for ambiguous typed data and for a `deploy_and_invoke` whose
  `user_address` differs from `deployment.address`; the handler maps both to
  `INVALID_PARAMS` (`-32602`).
- `extractTargets(params: unknown, source?: "build" | "execute"): ExtractedTargets | null`
  pulls the calls, deploy class hash, and rate-limit key out of a build or execute params
  object. **Method-aware for security:** with `"execute"` it reads calls ONLY from the
  signed `transaction.invoke.typed_data.message` (V2 `Calls` or V1 `calls`, chosen by the
  signed `typed_data.domain`), never a client-supplied `invoke.calls`, so a caller cannot
  get a benign transaction validated and then execute a different one. Defaults to
  `"build"` (reads `transaction.invoke.calls`). Returns `null` when there is no usable
  transaction object.
- `checkTransaction(targets: ExtractedTargets, policy: SponsorshipPolicy): PolicyDecision` validates extracted targets against the allowlist and the sponsored class hashes.
- `checkBuildTransaction(params: unknown, policy: SponsorshipPolicy): PolicyDecision` and `checkExecuteTransaction(params: unknown, policy: SponsorshipPolicy): PolicyDecision` are thin wrappers that `extractTargets` for their respective path and then `checkTransaction`.
- `hasLimit(policy: SponsorshipPolicy): boolean` is true when the policy sets any `rateLimit` or `globalCap` (the shared "a limit is configured" predicate).

### Exported types

- `AllowedCall { to: string; selectors?: string[] }`: a sponsorable target; omit `selectors` to allow any selector on `to`.
- `FeeMode { mode: "sponsored" | "default"; gas_token?: string }`: the fee mode the proxy forces onto forwarded requests.
- `SponsorshipPolicy`: the full policy object (fields documented under [Policy JSON shape](#policy-json-shape)): `allowedCalls`, `sponsoredClassHashes`, and optional `rateLimit`, `globalCap`, `feeMode`, `maxTip`, `allowInMemoryStore`.
- `PolicyDecision { ok: boolean; rateLimitKey?: string; reason?: string }`: the result of a policy check.
- `ExtractedTargets { type: string; calls: { to: string; selector: string }[]; classHash?: string; rateLimitKey?: string }`: the normalized targets `extractTargets` returns.

### Node subpath

`@starkware-libs/anystark-paymaster-proxy/node` exports
`createPaymasterProxyHandler(env?: ProxyEnv): (request: Request) => Promise<Response>`,
a factory returning a standard Web fetch handler with its own memoized config
(default env `process.env`), and re-exports the `ProxyEnv` type. See
[`adapters/node/README.md`](./adapters/node/README.md) for Hono / Bun / Deno
mounting snippets and the HTTP status semantics.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```
