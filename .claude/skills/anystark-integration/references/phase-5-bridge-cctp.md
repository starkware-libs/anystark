REF-PHASE-5-OK

# Phase 5 - bridge / CCTP flows

## Purpose

Give users USDC movement between Solana and the derived Starknet account: deposit,
withdraw, refresh-safe resume, terminal-state parity, and durable transfer history (or a
recorded deferral). Fund-flow code: the strictest review and persistence discipline in
the skill.

## Entry criteria

- `plan.cctp_in_scope` is true (otherwise mark the phase `skipped` with the decision id
  and move on).
- P4 complete: actions flow through the executor.
- The P2 policy allowlists the CCTP calls; the Solana RPC proxy (PR 2b) is live.

## Checklist

- [ ] Deposit flow: burn, in-flight record persisted BEFORE the attestation wait,
      attestation poll, sponsored receive, busy-state UX.
- [ ] Withdraw flow: sponsored burn calls, attestation, `receiveOnSolana`, same
      persistence discipline.
- [ ] Browser `Buffer` polyfill in place wherever `receiveOnSolana` is reachable.
- [ ] Refresh-safe resume from local records, SDK scans as backstop.
- [ ] Terminal-state parity for every flow, resume included.
- [ ] Balance refresh at provable-move moments; validation suppressed while busy.
- [ ] Callback pin tests.
- [ ] History storage decision executed or deferral recorded.
- [ ] Adversarial review before each push.
- [ ] Live smoke: one small deposit and one small withdraw reach terminal states.

## PR plan

- **PR 5a "deposit":** the Solana-to-Starknet deposit flow (burn, persist the in-flight
  record BEFORE the attestation wait, attestation poll, sponsored receive),
  busy-state UX.
- **PR 5b "withdraw":** the Starknet-to-Solana withdraw flow (sponsored burn calls,
  attestation, `receiveOnSolana`), same persistence discipline.
- **PR 5c "resume + terminal states":** refresh-safe resume from local records with the
  SDK scans as backstop; terminal-state parity; balance-refresh moments; callback pin
  tests.
- **PR 5d "history storage":** server-side durable transfer history keyed by the derived
  Starknet address (recommended), OR a recorded deferral decision with the gap
  documented (recovery records are NOT history).

Ask the user: history storage now vs deferred (recommend now when the dapp already has a
transfer-history surface, else defer; deferral means completed transfers leave no
history, recorded as the decision's consequence).

## Catalog

- **API shape (v0.1.x):** `new CctpBridge(CCTP_TESTNET_CONFIG | CCTP_MAINNET_CONFIG)`
  from `@starkware-libs/anystark-cctp`; override `solana.rpcUrl` with the proxied URL
  from P2 and `starknetRpcUrl` with the app's own node (the shipped configs default to
  public endpoints). The package is beta: re-verify the config's addresses against
  Circle's published CCTP tables before relying on them. Deposit:
  `depositFromSolana(params)` burns on Solana (standard finality,
  `maxFee` 0, so minted == burned; the recipient is the counterfactual address) and
  returns the base58 burn signature; then poll `fetchAttestation(domain, ref)`; complete
  with a sponsored `buildReceiveOnStarknetCall(message, attestation)`. Withdraw:
  `buildWithdrawToOwnerCalls(amount, ownerPubkey)` (an `approve` plus a
  `deposit_for_burn`, fast finality, `max_fee = amount/200` floored at 1), attestation,
  then `receiveOnSolana(...)`. Lower-level:
  `buildWithdrawToSolanaCalls(amount, recipientAta32)`; the caller owns the recipient
  (any ATA can be targeted; nothing guarantees funds return to the connected wallet), so
  pass the connected wallet's own pubkey unless the product intends otherwise.
- **Buffer polyfill:** `receiveOnSolana` constructs its transaction with `Buffer`, which
  browsers do not ship. Provide a polyfill before calling it (e.g.
  `vite-plugin-node-polyfills`, or `globalThis.Buffer = Buffer` from the `buffer`
  package); the other bridge methods need none.
- **Persist BEFORE the wait:** write a local in-flight record for every burn BEFORE the
  attestation wait begins; offer refresh-safe resume from it. The SDK's chain scans
  (`findRecoverableDeposits(ownerPubkey, starknetRecipient)`,
  `findRecoverableWithdrawals(starknetSender, solanaOwner)`) are the authoritative
  backstop when records are gone: they discover storage-free from source-chain history
  plus the Circle attestation, deduped against destination used-nonces so completed
  transfers never resurface. The scans are bounded (a 10,000-signature cap on the
  deposit history scan, a ~1,500,000-block window on the withdraw event scan); a burn
  older than the bounds is not surfaced, one more reason the local records come first.
- **Recovery is not history:** local records are fund-safety, deleted on completion.
  Durable per-account transfer history belongs SERVER-SIDE, keyed by the derived
  Starknet account address (it is 0x-hex, so address-keyed stores built for EVM rows
  usually accept it unchanged); the client mirrors status POSTs at the same moments the
  flow advances, and a server-side reconciler (source-chain watchers plus attestation
  checks, the same queries the SDK scans run) closes the crashed-browser gap. When the
  dapp defers this, record the decision and the user-visible consequence (completed
  transfers leave no history).
- **Balance discipline:** `solanaUsdcBalance` returns `0n` only for a missing ATA; any
  other RPC failure THROWS. Treat a rejection as "unknown", never as zero. Refresh
  balance displays at the moments funds provably move (burn confirmed, completion,
  resume success). Suppress balance-vs-input validation while a flow is busy: the frozen
  input legitimately exceeds a refreshed balance mid-transfer.
- **Terminal-state parity:** every flow, INCLUDING resume, reaches the SAME terminal
  state as its happy path (receipt refs shown, done affordance, records cleared).
  Partial-batch completion keeps the remaining legs visible and actionable. Failure
  alerts keep every chain reference already acquired (burn AND destination), scoped to
  the failing leg.
- **Callback pin tests:** contract-shaped callbacks get their MEANING pinned by tests
  (e.g. "onSubmitted fires when a balance-affecting chain write landed", at the
  confirmed burn AND at completion, not "flow completed"), so a semantic change is
  conscious, not silent.
- **In-flight UX:** show which stage the transfer is in (burn sent, burn confirmed,
  attestation pending, receiving) with the burn reference visible and copyable; the
  attestation wait runs minutes, so say so instead of an indefinite spinner. On reload,
  an in-flight transfer surfaces itself with a resume affordance where the user started
  it, never buried behind navigation.
- Integrate with any bridge/funding UX found in P0 rather than duplicating it.

## Verification

- [ ] In-flight record exists before any attestation wait (test-pinned).
- [ ] Resume test: kill the flow after burn, resume, reach the happy-path terminal
      state.
- [ ] Scan backstop exercised at least once (records cleared, scans recover).
- [ ] Balance rejection renders "unknown", not zero (test-pinned).
- [ ] Callback pin tests pass and fail under mutation.
- [ ] Adversarial multi-facet review clean before each push.
- [ ] Live smoke on testnet, driven by the user: one small deposit and one small
      withdraw reach their terminal states; tx references recorded.

## Exit criteria

- PRs 5a-5c merged (5d merged or deferral recorded), CI green; the live smoke recorded.

Sentinels for resume probes: the deposit/withdraw flow modules; the in-flight record
store; the history endpoint or the deferral decision entry.
