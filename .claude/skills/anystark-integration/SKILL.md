---
name: anystark-integration
description: Integrate the AnyStark SDK (@starkware-libs/anystark-core, anystark-react, anystark-cctp, anystark-paymaster-proxy) into the Starknet dapp in the current repo, end to end - discovery, install, server-side paymaster proxy, Phantom wallet connector, routing app actions through the derived account, optional CCTP USDC bridging, per-action signing labels, and a live-funds test matrix - as a sequence of small CI-green PRs. Use when asked to "integrate AnyStark", "add Phantom / Solana wallet support", "let Solana users use this Starknet dapp", "add AnyStark bridging", or to "continue / resume the AnyStark integration". The integration spans several workdays: this skill resumes an in-progress run from its state file (.claude/anystark-integration.local.json) with no memory of earlier sessions, so also use it for any resume, status check, or next-step question about an AnyStark integration in progress.
---

# AnyStark integration

This skill drives a full integration of the AnyStark SDK into the Starknet dapp in the
current repo: discovery and planning, package install behind a feature flag and a lazy
seam, a server-side paymaster proxy, the Phantom wallet connector, routing every app
action through the derived Starknet account, optional CCTP USDC bridging, per-action
signing labels, a live-funds test matrix, and closeout. The work ships as a sequence of
small, individually CI-green, one-sitting-reviewable PRs and spans several workdays; a
state file makes any session resumable with no memory of earlier ones.

The skill integrates the SDK as published. It never modifies the SDK (section 7).

**Self-check, before anything else:** verify that a `references/` directory exists next
to this SKILL.md and contains `phase-0-discovery.md` through `phase-8-closeout.md`. If
any file is missing, halt and report a partial copy of the skill directory; do not
improvise phase content.

**Copyability:** this skill is designed to be copied as a whole
(`.claude/skills/anystark-integration/`, SKILL.md plus `references/`) into any Starknet
dapp repo. All paths in it are relative to the consumer repo root. The skill never edits
its own SKILL.md or reference files in the consumer repo.

## 1. Hard rules (never skip)

- NEVER modify the AnyStark SDK packages: no forks, no vendored copies, no
  `patch-package` or postinstall patches, no monkey-patching SDK internals. App-side
  wrappers around the public API are fine. A missing capability goes through the
  escalation procedure (section 7).
- Executing any step of phase N without having read `references/phase-<N>-*.md` IN THIS
  SESSION is a protocol violation: stop and read it. Each reference opens with a load
  token (`REF-PHASE-<N>-OK`); copy it into `state.phases[N].ref_token` as evidence. The
  resume protocol re-reads the active phase's reference first, every session.
- The state file never contains secrets: no tokens, no keys, no RPC URLs with
  credentials.
- State-file label honesty: write a status only after verifying it. `ci: "green"` only
  after checking the PR's checks; a live-matrix `pass` only with the user's confirmation
  and a recorded tx reference. Never mark done what you intend to do.
- Every PR is CI-green and reviewable in one sitting before the next stacked PR builds
  on it.
- Signing-path and fund-flow code gets an adversarial multi-facet review pass before
  push (section 6).
- Live funds move only by the human user driving their own wallet; the skill prepares,
  observes, and records. Testnet before mainnet, small amounts.
- Respect the consumer repo's own conventions discovered in P0 (formatter, commit
  format, i18n, protected files). When a repo convention and a skill suggestion
  conflict, the repo wins and the state records the adaptation.

## 2. State file

**Location:** `<repo-root>/.claude/anystark-integration.local.json`. In a monorepo the
file still lives at the repo root: one integration run per repo.

**Gitignore:** on first write, run `git check-ignore` on the path. If it is not ignored,
append `.claude/*.local.json` to the repo's `.gitignore` as part of the P1 foundation
PR; until that lands, keep the file out of all commits by explicit staging.

**Template** (values shown are placeholders):

```json
{
  "schema_version": 1,
  "skill_version": "1",
  "created_at": "<iso8601>",
  "updated_at": "<iso8601>",
  "reconstructed": false,
  "repo": {
    "origin_slug": "<org/repo>",
    "default_branch": "main",
    "app_path": ".",
    "package_manager": "npm|bun|pnpm|yarn",
    "extra_lockfiles": [],
    "bundler": "vite|next|webpack|other",
    "framework": "react|vanilla",
    "ssr": false,
    "ci": "github-actions|other|none",
    "pr_clis_available": ["gt", "gh"],
    "feature_flag_system": "<name or 'env-var'>",
    "deploy_platform": "<vercel|node|other>",
    "protected_files": []
  },
  "plan": {
    "chains": ["sepolia"],
    "mainnet_in_scope": false,
    "cctp_in_scope": true,
    "pr_tool": "gt|gh-stack|gh|git|<user free text>",
    "pr_tool_usage": "<free-text answer verbatim: what to use and how>",
    "flag_name": "<flag>",
    "brand_label": "<AppName>",
    "phases_planned": ["P0", "P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8"]
  },
  "decisions": [
    {
      "id": "D1",
      "at": "<iso8601>",
      "question": "",
      "options": [],
      "chosen": "",
      "recommended": "",
      "source": "user|derived"
    }
  ],
  "phases": {
    "P0": { "status": "not_started", "ref_token": null, "prs": [], "verification": {}, "notes": "" }
  },
  "prs_schema_note": "each phases[N].prs entry: { id, title, branch, base, number, url, state: planned|open|merged|closed|abandoned, ci: unknown|pending|green|red, review: unreviewed|changes-requested|approved, last_verified_at }",
  "pending_questions": [],
  "escalations": [
    {
      "id": "E1",
      "at": "",
      "capability": "",
      "why_needed": "",
      "workarounds_tried": [],
      "proposal": "",
      "resolution": "pending|workaround|feature-request-filed|descoped"
    }
  ],
  "live_matrix": [
    {
      "id": "M1",
      "case": "",
      "status": "untested|in_progress|pass|fail|blocked",
      "evidence": "<tx hash / user confirmation>",
      "at": null
    }
  ],
  "log": [{ "at": "", "phase": "", "event": "" }]
}
```

At P0 exit, create a `phases` entry for every planned phase. Phase `status` enum:
`not_started|in_progress|blocked|complete|skipped`. `skipped` records WHY in `notes` (a
discovery condition or a user decision id). The template's `decisions`, `escalations`,
and `live_matrix` entries illustrate shape; start those arrays empty.

**Active phase.** The active phase is the earliest entry in `plan.phases_planned` whose
status is neither `complete` nor `skipped`. There is no separate pointer field, so a
partial write never desyncs it. A phase transition sets the finished phase `complete`
and the next planned phase `in_progress` in ONE write.

**Per-phase detail.** On phase entry (right after reading the reference), write the
phase's PR plan as `planned` entries in `phases[N].prs`; a branch push fills `branch`, a
PR creation fills `number` and `url`. `phases[N].verification` maps each item of the
reference's Verification checklist to `{ at, evidence }`, written when the item is
verified, never before.

**Live-matrix partial progress.** A row's status gains `in_progress` the moment funds
move for it, with every chain reference already acquired (e.g. the burn tx) in
`evidence`. On resume, an `in_progress` row is completed or verified from that evidence
through the dapp's own resume flow before any new funds move; it never silently reverts
to `untested`.

**Update moments.** Write the whole file, append one `log` line, and refresh
`updated_at` at each of these moments, each BEFORE the next side effect:

- P0 plan confirmation
- every phase entry (the planned PR list)
- every decision
- every blocking question presented (recorded in `pending_questions` until answered;
  the answer becomes a `decisions[]` entry and clears it)
- every branch push
- every PR creation (record number and url)
- every observed CI result
- every PR merge observed
- every phase transition
- every escalation
- every live-matrix start (funds moved) and every result
- session end

**Re-entrancy.** Every step is re-entrant: its entry check runs first and the step does
nothing when already satisfied. Before any push, check whether the branch is already at
the expected commit; before any PR creation, check for an existing PR for that head
(`gh pr list --head <branch>`, or ask). State written before the next side effect plus
re-entrant steps means a dead session costs at most one duplicated probe, never a
double-applied step.

**Missing-file rebuild path** (first-class, not an error). When the state file is
missing or unparseable but the world shows progress, never silently restart P0. Rename
an unparseable file to `<name>.bak` before writing a fresh one.

1. Probe: `@starkware-libs/anystark-*` deps present in `package.json` and at what
   version; sentinel files per phase (each reference names its sentinels); local and
   remote branches whose names contain `anystark` (the recommended convention is
   `<user>/anystark/p<N>-<slug>`, but P0 may have adapted it); `gh pr list --search
"anystark"` open and merged (when `gh` is unavailable, ask the user for PR links and
   states, batched).
2. Map findings to the furthest completed phase.
3. Present the reconstructed timeline for the user to confirm.
4. Re-ask only decisions with no code fingerprint (chains, flag name, brand label, CCTP
   scope have fingerprints once built; the PR tool, waivers, and deferrals do not).
5. Write a fresh state file with `"reconstructed": true`.

Probes finding NO progress means a fresh run: start P0.

## 3. Resume protocol

Runs on EVERY invocation, before any action:

1. Read the state file. Missing or unparseable: take the rebuild path above.
2. Probe the world; probes are authoritative over the file:
   - `git fetch --prune`, then branch existence for every recorded PR branch (a merged
     PR whose head branch was deleted is normal, not a contradiction);
   - `gh pr view <n> --json state,mergedAt,statusCheckRollup` for every recorded PR
     that is not `merged`/`closed`/`abandoned` (when `gh` is available; otherwise ask
     the user for PR states, batched);
   - `package.json` at `repo.app_path`: `@starkware-libs/anystark-*` deps present, at
     what version; lockfile(s) in sync;
   - sentinel files per completed phase (each reference names its sentinels);
   - working tree: dirty files or unpushed commits from a dead session get reported,
     then ask (keep / discard / stop; recommend keep when the diff is exactly the
     recorded next step's expected edit, discard otherwise); never reset without an
     answer.
3. Reconcile. The world showing MORE done than the state (a PR merged during the gap) is
   the normal case: update the state and note it in the orientation. Refreshing a PR's
   probed state writes its `last_verified_at`. A contradiction (state says merged, PR is
   open): ask the user; never auto-resolve.
4. Print the orientation report (section 5).
5. Re-read the ACTIVE phase's reference file; refresh `ref_token`.
6. Act on the single next undone item.

## 4. Phase index

Each paragraph says what the phase delivers and its boundary conditions. It is
deliberately not actionable: the checklists, probes, catalog, and verification steps
live only in the reference file. Before executing any step of a phase, read its
reference file and record the load token (hard rule, section 1).

**P0 - discovery and plan.** Delivers the dapp-shape report, the confirmed plan, and
the state file. No PRs. Entry: skill invoked with no state file (and no rebuild
evidence); exit: plan confirmed by the user, state written, `phases_planned` fixed.
Read `references/phase-0-discovery.md` now.

**P1 - foundation.** Delivers the installed `@starkware-libs/anystark-*` dependencies,
the feature flag, and the lazy import seam with flags-off stubs; 1-2 PRs. Entry: P0
complete; exit: foundation PRs merged with the seam guard in CI. Read
`references/phase-1-foundation.md` now.

**P2 - paymaster proxy and server infra.** Delivers the server-side paymaster proxy
with a locked sponsorship policy, and (when bridging is planned) the Solana RPC proxy;
1-2 PRs. Entry: P1 complete; exit: the deployed proxy route verified answering. Read
`references/phase-2-paymaster-proxy.md` now.

**P3 - wallet connector.** Delivers the Phantom connector (or the core-lane account)
behind the seam, cross-wallet-family gating, and connected-account UX; 1-2 PRs. Entry:
P2 complete; exit: a no-funds connect smoke against real Phantom passes. Read
`references/phase-3-connector.md` now.

**P4 - app actions through the account.** Delivers one `LabeledExecutor` wired as the
account's signing path and every app action routed through it; 1..N PRs. Entry: P3
complete; exit: a live testnet smoke where the first sponsored action (the
counterfactual deploy) succeeds. Read `references/phase-4-app-actions.md` now.

**P5 - bridge / CCTP flows.** Optional: marked `skipped` at P0 exit (decision id in
`notes`) when `plan.cctp_in_scope` is false. Delivers deposit, withdraw, resume and
terminal states, and transfer-history storage or a recorded deferral; 2-4 PRs. Entry:
P4 complete; exit: one live testnet deposit and one live withdraw reach their terminal
states. Read `references/phase-5-bridge-cctp.md` now.

**P6 - per-action signing labels.** Delivers the label module (builders, degradation
ladder, byte tests) and per-call-site wiring; 1-2 PRs. Entry: P4 complete (P5 too when
planned); exit: the user approves the wording table and both PRs merge. Read
`references/phase-6-signing-labels.md` now.

**P7 - live-funds test matrix.** First-class phase; no feature PRs, fix PRs as needed.
Delivers a fully-driven matrix over everything built, recorded in `state.live_matrix`.
Entry: all feature phases `complete` or `skipped`; exit: every row `pass` or explicitly
waived by the user. Read `references/phase-7-live-funds-matrix.md` now.

**P8 - closeout.** Delivers the flag rollout plan, dapp-team docs, the final summary,
and the state file marked complete; 0-1 PR. Entry: P7 complete; exit: rollout decision
recorded and docs delivered. Read `references/phase-8-closeout.md` now.

## 5. Questions and UX

**Question policy.** Batch questions at natural boundaries (P0 plan, phase entries,
escalations), each with a recommended default, WHY, and what each option changes. When
the answer is derivable from the repo or from prior decisions, proceed on the
recommendation, announce the decision in one line as it is taken (an immediate veto
stays possible), and record a `decisions[]` entry with `source: "derived"`; the
orientation report lists recent derived decisions so a later veto stays cheap. Never
re-ask an answered question after a resume: decisions persist in state.

**Orientation report** (every session start, one screen):

1. current phase and status, with any blocked items or open escalations FIRST;
2. the confirmed plan in one line (chains, CCTP scope, PR tool, flag name, brand label),
   so a wrong plan surfaces early without a blocking question;
3. PR table: id, title, number/url, CI bucket, review state (freshly probed);
4. pending questions for the user;
5. recent derived decisions since the last session;
6. anything reconciled from the world (PRs merged during the gap);
7. the single next action.

**During work:** announce each step in one line before doing it; never dump logs, quote
only decisive lines; report each PR's URL when created.

**Session-end summary:** what changed this session; PRs opened/updated with links and
states; decisions taken (user vs derived); verification results; blocked/waiting items;
the exact next action; and the line "safe to close - invoking the skill again resumes
from `.claude/anystark-integration.local.json`".

**Phase-complete report:** deliverables shipped; PRs merged (list); the phase's
verification checklist with pass evidence; catalog items applied vs waived (with
decision ids); deferred items carried forward; next phase and its first question batch
if any.

## 6. PR and process rules

- **Branch naming:** `<user>/anystark/p<N>-<slug>`, adapted to any repo convention found
  in P0.
- **PR management CLI:** the user's P0 choice (`plan.pr_tool`), never inferred from what
  is installed: `gt` (`gt submit`, Graphite stacking), `gh-stack` (`gh pr create` plus
  the user's gh stacking extension for restacks), `gh` (`gh pr create`, bases managed by
  hand), `git` (push the branch and give the user the compare URL to open the PR,
  recording the number and state they report), or whatever the user types as free text:
  their answer is recorded verbatim in `plan.pr_tool_usage` and PRs are driven exactly
  as it instructs. When a needed command (create, update, restack) is unclear from it,
  learn the tool first - its own help (`<tool> --help`, subcommand help) and its official
  web documentation - and ask a follow-up only for what those leave ambiguous, recording
  what was learned in `plan.pr_tool_usage`. The stacked rules below apply when the
  chosen tool restacks; the sequential degrade applies when it does not.
- **Deploys:** the skill never triggers a production deploy or flips a production flag;
  it asks the user, or verifies against the platform's preview deployments.
- **Stacked incremental PRs:** each CI-green, each reviewable in one sitting. With a
  stacking tool (`gt`, `gh-stack`): restack after EVERY downstack merge; GitHub retargets
  bases but never rebases, and import-line conflicts are the common case. Without one
  (`gh`, `git`): sequential PRs, each based on the previous branch, retargeted to the
  default branch as predecessors merge; never one mega-PR.
- **CI checks the PR merge ref:** stacked PRs sharing a file must be REBASED after the
  shared file changes downstack, not patched with an added commit, or CI greens against
  a merge ref that will not exist.
- **No CI in the repo:** "CI-green" degrades to "the repo's own verify commands pass
  locally", recorded per PR in `phases[N].prs[].ci` with a note.
- **Adversarial multi-facet review** before pushing any signing-path or fund-flow code:
  separate reviewer passes per facet (correctness, funds safety, label honesty, UX
  states, tests), then one combined fixer, loop until clean.
- **Automated-reviewer (bot) rounds:** adjudicate each finding - fix if true, refute
  with cited evidence if not, reply to and resolve every thread; never rubber-stamp.
  Expect most findings true and roughly one refutable per round.
- **Mutation-check critical fixes:** revert the fix, prove the test fails, restore.
- **Test-name hygiene:** before pushing, sweep test names for leaked review-artifact
  prefixes (`C1:`, `H4:`, `MAJOR:`, numbered-list residue).
- **Reporting honesty:** never claim a check, CI, or live result without having
  verified it in this session; the state file follows the same rule.

## 7. SDK-boundary escalation

When the integration needs something the SDK does not provide:

1. **Confirm the gap.** Re-read the relevant package README and the installed package's
   type declarations; check the subpaths (`@starkware-libs/anystark-react/testing`,
   `@starkware-libs/anystark-cctp/addresses`,
   `@starkware-libs/anystark-core/cctp-addresses`,
   `@starkware-libs/anystark-paymaster-proxy/node`). Many "gaps" are subpath exports.
2. **Classify.**
   - (a) An app-side workaround exists that respects SDK invariants (wrapping public
     API, composing calls, app-side state): implement it, record a `decisions[]` entry.
   - (b) A workaround exists but costs UX, safety margin, or maintainability: present
     the options with a recommendation and let the user decide.
   - (c) No acceptable workaround: stop the affected work item only.
3. **On (c):** write an `escalations[]` record (capability, why it is needed,
   workarounds tried and why rejected, a drafted feature request the user can file
   against the SDK repo), mark the dependent items `blocked`, continue all unblocked
   work, and ask the user: file the feature request / accept a descoped integration /
   pause the phase.
4. **Never**, under any classification: fork, vendor, patch (postinstall or otherwise),
   or monkey-patch the SDK packages; never pin to an unpublished build.

**Known invariants that are NOT gaps** (do not escalate these):

- A paymaster is required: execution is sponsored-only by design.
- `signingLabel` accepts only `string | LabeledExecutor`; there is no bare function
  form.
- Labels reject Unicode Cc/Cf/Zl/Zp/Cs codepoints (controls, bidi overrides,
  zero-width, BOM, line/paragraph separators, lone surrogates).
- `account.execute` bypassing an idle `LabeledExecutor` throws at sign time by design.
- `solanaUsdcBalance` throwing on transport errors is by design: a rejection means
  "unknown", never zero.
- `PhantomConnector.request()` throws by design: transactions go through the connected
  account.
- `SolanaAsStarknetSigner.getPubKey()` throws by design: the Ed25519 key does not fit a
  felt, so there is no STARK public key.
