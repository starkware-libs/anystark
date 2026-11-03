REF-PHASE-7-OK

# Phase 7 - live-funds test matrix

## Purpose

Prove the whole integration against real wallets and real (small) funds. Live testing
repeatedly caught what review rounds missed: wrong number provenance, stale balances
mid-flow, missing terminal states. This phase is first-class, not a smoke appendix.

## Entry criteria

- Every feature phase in `plan.phases_planned` is `complete` or `skipped`.
- The per-phase live smokes (P4, P5) already passed.

## Checklist

- [ ] Matrix generated at phase entry from what was actually built, written into
      `state.live_matrix` (one row per case per chain in scope).
- [ ] Every row driven by the human user, evidence recorded.
- [ ] Every failure turned into a fix PR, mutation-checked, and its row re-run.
- [ ] Testnet fully green before any mainnet row.

## PR plan

No feature PRs. Every matrix failure becomes a fix PR: one-sitting, CI-green,
adversarial review when it touches signing or fund paths, mutation-checked (revert the
fix, prove the test fails, restore), then the matrix row is re-run.

## Catalog

**Matrix template.** Instantiate per chain in scope, from what was built; drop rows for
skipped features, add rows for dapp-specific flows found in P0:

- happy path per flow: connect; first action = counterfactual deploy; every app action;
  deposit; withdraw;
- cancel at EVERY signature point (each flow, each signature);
- refresh mid-flight at every stage of every flow, then resume;
- resume flows reaching the SAME terminal state as their happy paths;
- over-balance attempts (validation, and suppression while a flow is busy);
- partial-batch completion and partial-batch resume (remaining legs visible,
  actionable);
- popup label check: the human READS each Phantom popup and confirms the label matches
  the action's real numbers;
- balance displays refresh at the provable-move moments.

**Rules:**

- The human drives the wallet and confirms each observation; the skill prepares each
  case (exact steps, expected observations) and records the evidence (tx hashes,
  described screenshots).
- A row is `pass` only on the user's confirmation, with the evidence recorded (label
  honesty).
- Testnet fully green before any mainnet row; mainnet uses minimal amounts and starts
  only on the user's explicit go.
- Every failure: fix PR, mutation check, row re-run. Update `state.live_matrix` at every
  start (the row goes `in_progress` the moment funds move, with every chain reference
  acquired so far in `evidence`) and at every result, before the next side effect.
- A row found `in_progress` on resume is completed or verified from its recorded
  evidence, through the dapp's own resume flow, before any new funds move.

## Verification

- [ ] `state.live_matrix` covers every built flow on every chain in scope.
- [ ] Every row is `pass`, or `blocked`/waived with a recorded decision id.
- [ ] Every fix PR merged and its row re-run to `pass`.

## Exit criteria

- Every row `pass` or explicitly waived by the user (waiver recorded as a decision).
- When mainnet is in scope: the matrix repeated on mainnet with minimal amounts, after
  testnet is fully green and on the user's explicit go.

Sentinels for resume probes: `state.live_matrix` rows and their evidence.
