REF-PHASE-0-OK

# Phase 0 - discovery and plan

## Purpose

Produce the dapp-shape report, get the plan confirmed, and write the state file. The
whole integration is parameterized by what this phase finds: which SDK packages to
install, where server code lives, which phases apply, and which repo conventions bind
every later PR.

## Entry criteria

- The skill is invoked with no state file, or the rebuild path reconstructed a run whose
  P0 is incomplete.

## Checklist

Run every probe; record results in `state.repo`.

- [ ] **Package manager:** which lockfiles exist (`package-lock.json`,
      `bun.lock`/`bun.lockb`, `pnpm-lock.yaml`, `yarn.lock`). More than one lockfile:
      record them in `repo.extra_lockfiles`; the lockfile-parity rule applies to every
      dependency change (regenerate ALL of them in the same PR).
- [ ] **Bundler:** `vite.config.*`, `next.config.*`, `webpack.config.*`; else inspect
      the build scripts.
- [ ] **Framework:** `react` in deps means the react lane
      (`@starkware-libs/anystark-react`); no react means the core lane
      (`@starkware-libs/anystark-core` directly). `@starknet-react/core` already
      present: the connector joins the existing `StarknetConfig.connectors` list in P3.
      Absent: either add starknet-react (react apps; recommended) or wire core directly.
- [ ] **SSR:** Next/Remix/SSR flags activate the client-only construction rules in
      P3/P4.
- [ ] **Monorepo:** `workspaces` field, `turbo.json`, `apps/` layout; set
      `repo.app_path` and prefix all later paths with it.
- [ ] **CI:** `.github/workflows/*` (which checks gate PRs), or other CI, or none (the
      SKILL.md section 6 degrade applies).
- [ ] **PR CLIs available:** which of `gt` (on PATH, or `.graphite_repo_config`
      present), authed `gh` (`gh auth status`), and a gh stacking extension
      (`gh extension list`) are usable here; record in `repo.pr_clis_available`.
      Detection informs the recommendation only; the tool itself is the user's choice in
      the question batch.
- [ ] **Feature flags:** grep for launchdarkly/statsig/unleash/config flags; none means
      an env-var flag (e.g. `VITE_ANYSTARK_ENABLED`), named per repo convention.
- [ ] **Secrets handling:** deploy platform config (`vercel.json`, Dockerfiles, env pull
      scripts); determines where `PAYMASTER_API_KEY` etc. live in P2.
- [ ] **Existing wallet UX:** the connect modal/menu component, existing connectors, any
      existing bridge/funding flows (P5 integrates with them rather than duplicating).
- [ ] **Conventions:** formatter (prettier/biome and where the config lives; run the
      repo's own format command, never a global one), commitlint scopes, i18n
      (user-visible strings may need locale files), test framework, protected/generated
      files.
- [ ] **Registry reachability:** can this environment install `@starkware-libs/*` from
      the npm registry, or from the mirror the repo installs through; P1 depends on it.

## PR plan

No PRs. This phase delivers a report, a confirmed plan, and the state file.

## Catalog

**The P0 question batch.** ONE batched prompt, each question with a recommended default,
why, and what each option changes:

- **Chains:** recommend sepolia-first, mainnet later (`plan.chains`,
  `plan.mainnet_in_scope`). Mainnet in scope adds the P2 rate-limit/cap decision and a
  mainnet live-matrix pass.
- **CCTP bridging in scope?** Recommend yes when the dapp holds or uses USDC balances,
  else no (`plan.cctp_in_scope`). No marks P5 `skipped`: Solana users then fund the
  derived account outside the dapp.
- **PR management CLI** (`plan.pr_tool`): `gt` (Graphite), `gh` with a stacking
  extension, plain `gh`, plain `git`, or another CLI the user names. Recommend the
  strongest detected option (`gt` when configured, else authed `gh`, else `git`), but
  ask even when only one is detected: teams standardize on a tool, and the wrong one
  leaves the integration's PRs outside their review flow. Consequences: `gt`/`gh-stack`
  get restacked stacks; plain `gh` gets sequential PRs with hand-retargeted bases;
  `git` means the user opens each PR from a compare URL and reports its number back.
  The question always offers a free-text answer: the user types what to use and how,
  and that text is recorded verbatim in `plan.pr_tool_usage` for every later session.
  When it leaves a needed command (create, update, restack) unclear, learn the tool from
  its own help output and its official web documentation, append the learned commands to
  `plan.pr_tool_usage`, and ask a follow-up only for what remains ambiguous.
- **Flag name** (`plan.flag_name`), per the flag system discovered.
- **Brand label string:** recommend the app's display name (`plan.brand_label`).
- **Paymaster deploy target:** recommend the platform discovered.
- Anything ambiguous from detection (e.g. two plausible app paths).

Everything else is recommend-and-proceed with a recorded `decisions[]` entry
(`source: "derived"`).

**Dapp-shape report:** present the probe results as one compact table before the
question batch, so the user confirms the plan against visible evidence.

## Verification

- [ ] Every checklist probe has a recorded result (no "unknown" left silently).
- [ ] The dapp-shape report was presented.
- [ ] The plan (phases, lanes, chains, flag, brand label) was confirmed by the user.

## Exit criteria

- Plan confirmed by the user.
- State file written, with a `phases` entry per planned phase.
- `plan.phases_planned` fixed; a descoped P5 is marked `skipped` with its decision id;
  the connector lane (react vs core) and `plan.pr_tool` recorded as decisions.

Sentinel for later resumes: the state file itself.
