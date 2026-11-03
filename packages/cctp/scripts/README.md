# CCTP mainnet verification harness

> ⚠️ **Unaudited code. Use at your own risk.**
>
> This code has not been audited or fully tested and may contain bugs or security vulnerabilities. It is provided “as is” without warranty of any kind. Do not use it in production or with real funds unless you have reviewed and tested it yourself.

`verify_mainnet.mjs` is the reproducible ritual behind the `VERIFICATION STATUS`
block on [`CCTP_MAINNET_CONFIG`](../src/config.ts). It drives a real
Solana mainnet-beta ↔ Starknet mainnet USDC round trip through the shipped config,
with no browser and no Phantom: a throwaway Ed25519 seed plays both the Solana
wallet and the AnyStark account's signer.

Run it from this directory with `bun` (the workspace packages export TypeScript
source, so plain `node` cannot import them by package name):

```sh
cd packages/cctp/scripts
bun verify_mainnet.mjs --preflight
```

## Modes

| Mode                | Costs                         | What it proves                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--preflight`       | nothing                       | Config sanity, both Solana programs deployed + executable, USDC mint decimals, all three Starknet contracts deployed, Starknet USDC reads, ATA + address derivation, call building, mainnet Anchor IDLs fetchable, production Iris reachable, Circle's live fee schedule for both lanes (and that the default amount survives it), paymaster available. Exits non-zero on any failure. |
| `--setup`           | nothing                       | Generates (or reuses) the throwaway seed, derives the Solana pubkey, its USDC ATA, and the counterfactual `sol_account`, cross-checks the derivation against `SolanaAsStarknetAccount.address`, and reports funding readiness. Writes the state file; sends no transactions.                                                                                                           |
| `--dry-deposit`     | nothing                       | Builds and **simulates** the Solana `depositForBurn` against the live mainnet IDLs without sending it.                                                                                                                                                                                                                                                                                 |
| `--sponsored-probe` | sponsorship credits           | One zero-value Starknet `approve`, proving the paymaster sponsors a `sol_account` execute on mainnet and landing the counterfactual deploy. No USDC.                                                                                                                                                                                                                                   |
| `--run`             | **real USDC + SOL + credits** | The full round trip: burn on Solana → Circle attestation → `receive_message` on Starknet → burn on Starknet → attestation → `receive` on Solana. Also the hosted-paymaster parity test (below).                                                                                                                                                                                        |

## What a funded run costs

- **USDC**: 0.01 USDC by default — a deliberate one-cent verification, since the
  point is the wiring and not the value. Override with `--amount=<decimal>`. Fund the
  throwaway wallet with 0.05 USDC to cover it, or 1-5 USDC for headroom to repeat.
- **SOL**: transaction fees plus rent for the ephemeral `messageSentEventData`
  account, the used-nonce account the Solana-side receive creates, and the USDC ATA
  if the wallet has never held USDC. 0.01 SOL minimum, 0.02 SOL comfortable. This
  dominates the dollar cost of the run.
- **AVNU sponsorship credits**: both Starknet legs (and the counterfactual deploy
  that rides the first one) are paid by the paymaster. The key must be a **mainnet**
  key with credits on it — self-serve at <https://paymaster.avnu.fi>, no allowlist,
  but the credits are prepaid. The run prints the on-chain fee AVNU covered per
  transaction and in total, which is what the credits bill against (AVNU may add its
  own margin on top, which is not visible on-chain).
- **There are no faucets and no airdrops on mainnet.** Real funds must be sent from
  a wallet you control.

### Why 0.01 USDC works

The two legs are priced differently, and the harness checks Circle's **live** fee
schedule (`/v2/burn/USDC/fees/{src}/{dst}`) rather than assuming:

- **Deposit** (Solana → Starknet) burns at standard finality with `max_fee = 0`.
  Circle charges 0 bps there, so the mint is exact.
- **Withdraw** (Starknet → Solana) burns at fast finality, where Circle's published
  minimum is 12 bps. The bridge's `max_fee` ceiling is `amount / 200` = 50 bps, so
  the fee fits with room to spare: 0.01 USDC = 10 000 raw units pays a 12-unit fee
  against a 50-unit ceiling and returns 0.009988 USDC.

`--run` re-checks this against the live schedule **before** the first burn, and
refuses to burn an amount the return leg cannot carry — printing the smallest viable
amount for the lane instead of stranding USDC on Starknet.

### The paymaster key

`PAYMASTER_API_KEY` is read first. If it is unset and `PAYMASTER_KEY_ENV_FILE` names a
dotenv file (e.g. a consuming dapp's untracked `.env.local` that already holds a working
key), the harness reads `PAYMASTER_API_KEY` from it, so an operator need not re-export the
key. It is used as a request header and is never printed or persisted; the harness logs
only which source it came from.

Any SNIP-29 paymaster works, not just AVNU: `PAYMASTER_URL` overrides the endpoint (default
is AVNU's hosted mainnet paymaster) and `PAYMASTER_KEY_HEADER` overrides the auth header
(default `x-paymaster-api-key`, which AVNU and the anystark paymaster-proxy expect).

### Hosted-paymaster parity

A funded run is also the parity test for AVNU's hosted mainnet paymaster against this
SDK's **custom** `sol_account` class — hosted paymasters generally allowlist the
standard wallet classes, so this is not a given. The run tracks two things
separately and prints an explicit verdict line:

```
  hosted AVNU mainnet sponsors custom class deploy+invoke : PASS
    deploy_and_invoke sponsored : yes
    plain invoke sponsored      : yes
    on-chain fee AVNU covered   : 0.000xxx STRK across 2 tx this run
```

`deploy_and_invoke` is proven by the deposit leg's `receive_message`, which is the
account's first-ever transaction and therefore carries the counterfactual deploy;
`plain invoke` is proven by the withdraw leg's burn. Both verdicts persist in the
state file, so a resumed run does not lose one it already earned. `--sponsored-probe`
prints the same line for the deploy half alone, without touching USDC.

`SolanaAsStarknetAccount` always executes through a paymaster — a Solana-derived
account holds no STRK, so there is no truly self-paid path. The closest equivalent is
SNIP-29 `default` fee mode, where the account repays the paymaster in a gas token:

```sh
bun verify_mainnet.mjs --run --fee-mode=default --gas-token=<felt> --max-gas-fee=<raw>
```

That still needs the paymaster, but the credits come off the account rather than
your AVNU balance. The account must hold that gas token.

## The exact sequence

```sh
cd packages/cctp/scripts

# 1. no funds needed — do this first, and in CI
bun verify_mainnet.mjs --preflight

# 2. generate the throwaway wallet and print funding instructions
export PAYMASTER_API_KEY=<mainnet paymaster key>   # or leave the dotenv fallback to it
bun verify_mainnet.mjs --setup

# 3. send real SOL (~0.02) and real USDC (0.05 is enough) to the printed WALLET
#    address, then re-run --setup until it reports the wallet funded

# 4. optional dry runs
bun verify_mainnet.mjs --dry-deposit        # simulates the burn, sends nothing
bun verify_mainnet.mjs --sponsored-probe    # one sponsored tx, no USDC

# 5. the real thing (0.01 USDC by default)
bun verify_mainnet.mjs --run

# 6. on `ROUND TRIP: PASS`, tick round-trip-verified (and paymaster-parity, if that
#    line also says PASS) in ../src/config.ts and record the ledger's tx refs there.
#    Then sweep the wallet and delete the state file.
```

For anything beyond a smoke test, point the harness at your own nodes — the public
endpoints in `CCTP_MAINNET_CONFIG` will rate-limit the recovery scans:

```sh
export STARKNET_RPC_URL=https://your-starknet-node
export SOLANA_RPC_URL=https://your-solana-node
```

## Safety properties

- **Resumable per leg.** Every on-chain identifier is persisted the moment it
  exists — the Solana burn signature is written _before_ confirmation — so an
  interrupted run resumes exactly where it stopped. Just re-run `--run`.
- **No double burns.** Before issuing a burn, `--run` asks the chain whether one is
  already in flight (`findRecoverableDeposits` / `findRecoverableWithdrawals`) and
  adopts it if so. That is also the recovery path if the state file is lost
  entirely: the in-flight transfer is rediscovered from chain history.
- **Reverts are not retried forever.** A Starknet transaction that reverts has its
  stored hash forgotten, so a resumed run re-submits instead of waiting on a
  transaction that will never succeed.
- **Network guard.** The harness refuses to run unless the Starknet RPC reports
  `SN_MAIN` and the `sol_account` class is declared there, and `--preflight` refuses
  a Solana RPC whose genesis hash is not mainnet-beta.
- **Secrets are never printed.** Not the seed, not the paymaster key. The state file
  (`.verify-mainnet-state.json`, gitignored) is written `0600` and holds the seed in
  plaintext — it is a disposable key that briefly holds real funds. Sweep it and
  delete the file when you are done.
