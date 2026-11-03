REF-PHASE-6-OK

# Phase 6 - per-action signing labels

## Purpose

Replace the static brand label with per-action labels: what the user reads in the
Phantom popup above the hash they sign. The popup is a trust surface; a wrong label is
worse than no label.

## Entry criteria

- P4 complete (and P5 when planned), so every labeled call site exists.

## Checklist

- [ ] Pure label builders per action type, taking the execution inputs as arguments.
- [ ] Degradation ladder and byte helpers implemented and tested.
- [ ] Worst-case byte pin test against the 258-byte hard cap.
- [ ] Labels passed at each `executor.execute` call site, derived from the SAME
      variables the calls are built from.
- [ ] Third-party strings interpolated into labels are sanitized (catalog: combining
      marks).
- [ ] Wording table reviewed and approved by the user.
- [ ] Adversarial review before each push.

## PR plan

- **PR 6a "label module":** pure label builders per action type, the degradation ladder,
  byte helpers, and tests (format tests with real values, per-rung ladder tests, a
  worst-case byte pin against the 258-byte hard cap).
- **PR 6b "wiring":** pass labels at each `executor.execute` call site, derived from the
  SAME variables the calls are built from; present the wording table to the user for
  review. This is a user-facing trust surface: always ask, with the drafted labels as
  the recommendation.

## Catalog

- **The popup is a trust surface.** The label is what the user reads above the hash they
  sign; a wrong label is worse than no label.
- **Provenance rule:** label values derive from the SAME variables the calls are built
  from, never from ambient UI state. (In a production integration, a store value
  published by an effect went stale against the executed calldata; reviews rationalized
  it, live testing caught it.) The label builder takes the execution inputs as
  arguments.
- **Content rules:** the headline number is the user's INTENT (their target); context
  numbers are droppable clauses; amounts exact, never rounded; never state a number
  absent from the calldata (claim an amount only when the calldata carries a real floor
  for it, e.g. a `min_payout`).
- **Byte budget:** prefer <= 130 UTF-8 bytes (2 SHA-512 blocks; the account re-hashes
  the message on every validation, so bytes recur as gas forever, and there is no gas
  difference within a block). Degradation ladder, in order: drop context clauses, then
  time, then separators, then date, then abbreviate the brand header to its initials
  (e.g. an `Acme Markets:` header becomes `AM:`). NEVER trim asset, prices, amounts, or the
  destination address: shipping over budget beats losing information. The SDK hard cap
  is 258 bytes (`MAX_LABEL_BYTES`); keep a worst-case pin test proving the ladder's
  floor stays under it.
- **Wording review for false readings:** e.g. "profit > $X" reads as a profit-size
  claim; "gain if > $X" correctly conditions on price. Present the full wording table to
  the user before merge.
- **Validation:** labels rejecting Unicode Cc/Cf/Zl/Zp/Cs (controls, bidi overrides,
  zero-width, BOM, U+2028/U+2029, lone surrogates) is SDK-enforced; do not try to
  smuggle formatting. The SDK filter does not cover combining marks: one at the start of
  interpolated text restyles the character before it, so sanitize third-party strings
  (token names, order notes) before splicing them into a label.
- **Tests:** builders as pure functions; format tests using REAL session values;
  per-rung ladder tests (each rung individually sufficient); the byte-length helper
  tested on multi-byte content; a resume-suffix variant when flows relabel on resume.

## Verification

- [ ] Format tests use real session values and pass.
- [ ] Each ladder rung has its own test; the worst-case pin proves the floor is under
      258 bytes.
- [ ] A grep proves every `executor.execute` call site passes a built label (or a
      recorded decision says which keep the default).
- [ ] The user approved the wording table (decision recorded).
- [ ] Adversarial multi-facet review clean before each push.

## Exit criteria

- PR 6a and 6b merged, CI green; wording approval recorded. The live popup check (the
  human reads each popup against the action's real numbers) runs in P7.

Sentinels for resume probes: the label module and its tests; labels at the execute call
sites.
