REF-PHASE-4-OK

# Phase 4 - app actions through the account

## Purpose

Route every app action through the derived account via ONE `LabeledExecutor`, so every
signature the user sees is labeled and no execute path bypasses the labeling seam.

## Entry criteria

- P3 complete: connect smoke passed.

## Checklist

- [ ] Exactly one `LabeledExecutor` instance, created behind the lazy seam, wired as the
      connector's `signingLabel`.
- [ ] One execution helper; EVERY app execute path calls
      `executor.execute(account, calls, label?)`.
- [ ] Call-site audit complete: every path that can reach `account.execute` (framework
      hooks like a send-transaction hook included) routed through the helper.
- [ ] Each app action (or group) migrated in its own reviewable PR.
- [ ] Adversarial review pass before each push (signing-path code).
- [ ] Live smoke: first sponsored action succeeds from a fresh key with zero balance.

## PR plan

- **PR 4a "executor wiring":** ONE `LabeledExecutor` instance created behind the lazy
  seam (`new LabeledExecutor("<brand>")`), wired as the connector's `signingLabel`; an
  execution helper so EVERY app execute path calls
  `executor.execute(account, calls, label?)`; the audit routing all existing
  `account.execute` and hook `sendAsync` call sites on the labeled account through it.
  The default label is fine at this phase.
- **PR 4b..4n:** migrate each existing app action (or group) onto the account, one
  reviewable PR per action group.

## Catalog

- **One executor, every path:** exactly ONE `LabeledExecutor` instance, created behind
  the lazy seam, wired as `signingLabel`. EVERY execute on the wired account goes
  through `executor.execute(account, calls, label?)`. The SDK enforces the invariant at
  sign time while the executor is idle (a bypassing `account.execute()` throws with a
  descriptive error); a bypass CONCURRENT with a labeled call in flight is shown that
  call's label undetected. That residual case is why the call-site audit matters, not
  just the runtime check. Executes are serialized and labels are one-shot and
  finally-cleared, so a label can never attach to another call's signature.
- Audit every path that can reach `account.execute`, framework hooks included, and route
  them through one execution helper.
- An omitted label means the constructor default; `''` means sign the bare hash for that
  one call.
- The first live action doubles as the counterfactual-deploy smoke (phase exit): the
  first sponsored `execute()` on a fresh account is a paymaster-funded
  `deploy_and_invoke`.

## Verification

- [ ] A repo grep proves no `account.execute` / send-hook call site on the labeled
      account outside the execution helper.
- [ ] Unit tests: helper routes through the executor; default-label behavior pinned.
- [ ] Adversarial multi-facet review clean before each push.
- [ ] Live smoke on testnet, driven by the user: the FIRST sponsored action (the
      counterfactual `deploy_and_invoke`) succeeds from a fresh key with zero balance;
      tx reference recorded in the state file.

## Exit criteria

- All action PRs merged, CI green; the live smoke recorded with its tx reference.

Sentinels for resume probes: the executor instance in the seam module; the execution
helper module; migrated call sites.
