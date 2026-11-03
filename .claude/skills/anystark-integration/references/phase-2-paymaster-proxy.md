REF-PHASE-2-OK

# Phase 2 - paymaster proxy and server infra

## Purpose

Stand up the server-side paymaster proxy that holds the sponsorship credential and
enforces a declarative policy, plus (when bridging is planned) the Solana RPC proxy. A
paymaster is required: the AnyStark account executes sponsored-only, so nothing in P3+
works until this route answers.

## Entry criteria

- P1 complete: packages installed, seam in place.

## Checklist

- [ ] Proxy mounted at a same-origin route (e.g. `/api/paymaster`).
- [ ] `PAYMASTER_API_KEY`, `PAYMASTER_UPSTREAM_URL`, `PAYMASTER_POLICY` set as platform
      env vars; the key never appears client-side.
- [ ] `PAYMASTER_POLICY` produced by the package's policy generator (catalog);
      `allowedCalls[]` covers every sponsored `(contract, selector)` pair;
      `sponsoredClassHashes[]` includes the pinned `sol_account` class hash.
- [ ] Policy lock tests: byte identity against the SDK's exported constants.
- [ ] Rate limit / global cap decision recorded (Upstash vars when configured).
- [ ] Solana RPC proxy in place when P5 is planned.
- [ ] Deployed route answers `paymaster_isAvailable`.

## PR plan

- **PR 2a "proxy":** mount `createPaymasterProxyHandler` from
  `@starkware-libs/anystark-paymaster-proxy/node` (or the platform adapter) at a
  same-origin route; env vars on the platform; the policy generated with the package's
  generator (catalog), covering every `(contract, selector)` the dapp sponsors (the
  recommendation derives from the dapp's existing contract calls plus the CCTP calls
  when P5 is planned); the policy lock tests (catalog). Upstash vars when a rate limit /
  global cap is configured (recommend yes for mainnet scope).
- **PR 2b "Solana RPC proxy"** (only when P5 is planned): an env-gated provider RPC URL
  with a same-origin `/api` proxy fallback, because public Solana endpoints 403 browser
  origins.

Ask the user: the final allowlist contents (present the recommended list as a
diff-style table; a missing selector fails that flow's sponsorship at execute time, an
extra one widens what a drained key could sponsor); the Upstash / rate-limit choice
(recommend on for mainnet scope; off leaves the gas budget capped only upstream).
Proceed on: the route path, the adapter choice (derived from the platform).

## Catalog

- **The browser never sees a credential.** The proxy holds `PAYMASTER_API_KEY`
  server-side and injects it upstream; the SDK's `paymaster.nodeUrl` points at the proxy
  route. A leaked bundle must not be able to drain the gas budget.
- **Generate the policy, never hand-write it:** the package ships a policy generator
  (`npx --package @starkware-libs/anystark-paymaster-proxy anystark-paymaster-policy`;
  with the package installed, the `anystark-paymaster-policy` bin also runs from
  `node_modules/.bin` under any package manager)
  that takes contract addresses plus plain function names (repeatable
  `--call <address>:<fn1>,<fn2>`, `--rate-limit`, `--global-cap`), computes the
  `sn_keccak` selectors, always pins the chain's `sol_account` deploy class hash into
  `sponsoredClassHashes` (no flag can drop it), round-trips the result through the
  proxy's real `configFromEnv`, and prints an env-ready one-line `PAYMASTER_POLICY`.
  Dangerous-but-legitimate policies (an any-selector `--call`, no rate limit and no
  global cap) require explicit acknowledgment flags or it exits non-zero.
- **Policy is declarative and enforced on build AND execute:** `allowedCalls[]` entries
  are `{ to, selectors?: string[] }` (omitting `selectors` allows any selector on `to`,
  gated behind the generator's acknowledgment flag), plus `sponsoredClassHashes[]`;
  `executeTransaction` re-checks the allowlist from the signed SNIP-9/SNIP-12 typed
  data; the fee mode is forced to sponsored, client tips stripped or clamped.
  `configFromEnv` throws loudly on any malformation (missing key or policy, bad felts,
  duplicate targets, a rate limit without a durable store): a bad deployment fails fast.
  Embedders (not using an adapter) run
  `assertCoreDeployClassHashSponsored(config.policy)` right after `configFromEnv`; the
  adapters run it for you.
- **Upstream URL is defaulted:** `PAYMASTER_UPSTREAM_URL` falls back to the AVNU sepolia
  endpoint when unset. Set it explicitly in every deployment; on mainnet an unset value
  silently points sponsorship at the wrong network.
- **Rate-limit sizing:** limits count sponsoring RPC calls, and one completed
  sponsorship is a build plus an execute, about 2 slots. To permit N flows set
  `maxPerAddress` / `maxPerWindow` to roughly `2 * N`. Per-address limits are bypassable
  by address churn; production scope pairs `globalCap` with an external anti-sybil layer
  (edge per-IP limits, captcha).
- **Policy lock tests (byte identity):** assert the deployed policy's constants
  byte-identical against the SDK's exports in a unit test: the class hash against
  `resolveDeployClassHash({ chainId })`, the CCTP targets against
  `@starkware-libs/anystark-core/cctp-addresses` (a Solana-free import, safe in a
  backend test context; `@starkware-libs/anystark-cctp/addresses` re-exports the same
  constants). Drift then fails a test, not production sponsorship. Never hardcode the
  class hash: resolve it.
- **What must be allowlisted:** every selector the dapp's flows execute sponsored. When
  P5 is planned that includes `approve` on the Starknet USDC token, `deposit_for_burn`
  on the Starknet TokenMessenger, and `receive_message` on the Starknet
  MessageTransmitter (addresses read off the `CctpConfig` in use). The pinned account
  class hash for the counterfactual deploy is covered by the generator automatically.
- **RPC proxying:** public Solana RPC endpoints 403 browser requests; use an env-gated
  provider URL with a same-origin `/api` proxy fallback so the browser talks only to the
  app's origin.
- **Platform gotchas:** on Vercel, filesystem routing exposes `api/*` relative to the
  project Root Directory; a wrong root silently 404s the route. Whatever the platform,
  verify the deployed route answers `paymaster_isAvailable` before P3 depends on it.
- **Deploys are the user's:** the skill never triggers a production deploy. Verify the
  route on the platform's preview deployment, or ask the user to deploy; a local run of
  the route is fallback evidence, recorded as such in `phases[N].verification`.

## Verification

- [ ] Policy lock tests pass, and fail when a policy constant is perturbed (mutation
      check), then pass restored.
- [ ] `configFromEnv` startup check exercised: a deliberately broken env fails loudly in
      a test or a local run.
- [ ] The DEPLOYED route answers `paymaster_isAvailable`: POST
      `{"jsonrpc":"2.0","id":1,"method":"paymaster_isAvailable","params":[]}` to the
      route and confirm a JSON-RPC result.
- [ ] No credential in any client bundle or response (grep the build output).
- [ ] When P5 is planned: the browser reaches Solana RPC through the app origin only.

## Exit criteria

- PR 2a (and 2b when planned) merged, CI green; the deployed route verified.

Sentinels for resume probes: the proxy route module; the policy env/config; the policy
lock test file.
