REF-PHASE-8-OK

# Phase 8 - closeout

## Purpose

Turn a green integration into a shipped one: the flag rollout plan, docs the dapp team
can operate from, the final report, and the state file marked complete.

## Entry criteria

- P7 complete: matrix green or waived.

## Checklist

- [ ] Flag rollout plan drafted: staged enable with a recommended default; the user
      decides the flip (the skill never flips a production flag on its own).
- [ ] Team docs written: how the seam, proxy, and labels work; the policy-update
      procedure (allowlist changes re-run the lock tests); a runbook for stuck transfers
      (local records, the SDK recovery scans, where history lives or the recorded gap).
- [ ] Final summary report presented.
- [ ] State file marked complete.

## PR plan

- **PR 8a "docs + rollout"** (0-1 PR): the team docs and any rollout scaffolding
  (staged-enable config). Skip the PR when the repo keeps docs elsewhere; record where
  they went.

## Catalog

- **Rollout:** recommend a staged enable (internal users, then a percentage, then all),
  mapped onto the flag system discovered in P0. Present the recommendation; the user
  decides each flip. Watch the first enabled stage against the P7 evidence (same flows,
  same terminal states).
- **Docs cover operations, not history:** what exists and how to run it - the seam
  module and its guard, the proxy route and policy (and how to extend the allowlist
  safely), the label module and its budget tests, the stuck-transfer runbook.
- **Final report:** phases delivered with PR lists; decisions (user and derived);
  escalations and their resolutions; the live-matrix summary with evidence; deferred
  items with their recorded consequences (e.g. a history deferral); the rollout plan and
  its current stage.
- **State file:** set every phase `complete` (or `skipped` with its decision), append
  the closing log line, keep the file. It is the record; do not delete it.

## Verification

- [ ] The user confirmed the rollout plan (decision recorded).
- [ ] Docs merged or their location recorded.
- [ ] The final report was presented.
- [ ] Every deferred item carries a recorded decision and consequence.

## Exit criteria

- State file marked complete (kept, not deleted); rollout decision recorded; docs
  delivered.
