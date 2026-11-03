# sol_account (Cairo contracts)

> ⚠️ **Unaudited code. Use at your own risk.**
>
> This code has not been audited or fully tested and may contain bugs or security vulnerabilities. It is provided “as is” without warranty of any kind. Do not use it in production or with real funds unless you have reviewed and tested it yourself.

The Starknet account contract whose root signer is a Phantom / Solana **Ed25519** key.
This is a **Scarb** package (not an npm workspace) and the foundation of the project:
the contract implementation and the TypeScript SDK both build on it.

## Implementation status

`src/lib.cairo` is a single monolithic class. Its components:

1. signer storage (constructor + `public_key`, with zero / non-canonical-key rejection)
2. `__execute__`
3. validation entrypoints (`__validate__` / `__validate_deploy__` / `__validate_declare__`)
4. signature validation - message binding (base64 of the operation hash + optional
   readable label; see _Message binding_)
5. signature validation - Ed25519 verification (garaga), against the stored signer passed
   as `Py_twisted`, so signer binding is structural (a foreign key fails `'INVALID_SIG'`)
6. `IUpgradeable::upgrade` (self-authorized `replace_class`) + `Upgraded` event, gated by an
   `identity()` library-call guard (the target must self-report the sol*account identity),
   with a `version()` view (`IVersionedUpgrade`, non-gating metadata) and the self-only
   `execute_after_upgrade` migration hook that the upgrade requires (see \_Upgrades*)
7. SRC5 introspection + SNIP-9 outside execution (`execute_from_outside_v2` via OZ's
   `SRC9Component`)

`src/lib.cairo` fixes the public interface, storage, and events; tests live in
`src/test_sol_account.cairo` and `src/test_outside_execution.cairo` (with test-only mocks
in `src/test_mocks.cairo`).

## Build & test

```bash
scarb build         # compile to Sierra
snforge test        # contract tests
```

Toolchain is pinned to **scarb 2.18.0** and **starknet-foundry 0.60.0** (see
`.github/workflows/contracts.yml` and `Scarb.lock`). ⚠️ Run `snforge` with the **0.60.0
binary**: an older binary (e.g. 0.57.0) against the 0.60.0 `snforge_std` silently no-ops
cheatcodes like `start_cheat_caller_address`, making the `upgrade_*` tests fail
misleadingly. `snforge --version` must print `0.60.0`.

## Contract interface

`sol_account` is a single account contract (`sol_account::SolAccount`). Its public
entrypoints are grouped below by the Cairo trait that declares them. Signatures use Cairo
types. A valid signature returns the SNIP-6 magic value `'VALID'`. The two validation
surfaces differ on rejection: the transaction-validation entrypoints (`__validate__` /
`__validate_deploy__` / `__validate_declare__`) revert with a named reason, while
`is_valid_signature` is SNIP-6-conforming and returns `0` for every rejection it detects
(see _Error reference_).

### Constructor

```cairo
constructor(public_key: u256)
```

Stores the immutable Ed25519 signer (the 32-byte public key read as a little-endian `u256`)
and emits `SignerInitialized`. It asserts the key is usable, so a bad key cannot brick a
counterfactually derived address:

- `public_key != 0`, else `"public_key must be non-zero"`.
- the y coordinate (`public_key & ED25519_Y_MASK`) is a canonical field element
  (`< 2^255 - 19`), else `"public_key is not a canonical Ed25519 key"`.

It then registers the SRC5 interface ids the account answers for: `ISRC6_ID` directly, and
`ISRC9_V2_ID` through the SRC9 initializer.

### `ISolAccount` (SNIP-6 account core)

| Entrypoint           | Signature                                               | Description                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `__validate__`       | `(calls: Array<Call>) -> felt252`                       | Validates the current transaction: verifies the Ed25519 signature carried in the tx `signature` field and bound to the tx hash against the stored signer. Returns `'VALID'`.                                                                                                                                                                                                        |
| `__execute__`        | `(calls: Array<Call>) -> Array<Span<felt252>>`          | Runs the multicall as the account. Protocol-caller-only (asserts `caller == 0`, else `'INVALID_CALLER'`). Rejects any `Call` on the `execute_after_upgrade` selector with `'FORBIDDEN_CALL'`.                                                                                                                                                                                       |
| `is_valid_signature` | `(hash: felt252, signature: Array<felt252>) -> felt252` | Returns `'VALID'` when `signature` is a well-formed garaga EdDSA bundle whose signer matches the stored key and whose signed message is bound to `hash`; returns `0` for every rejection it detects (SNIP-6 conformance), matching how OZ accounts answer. A hint-tampered bundle that panics inside garaga's verifier is the lone case that still reverts (see _Message binding_). |
| `get_public_key`     | `() -> u256`                                            | Reads the stored Ed25519 signer (the pubkey bytes as a little-endian `u256`).                                                                                                                                                                                                                                                                                                       |

### `IDeployValidate` (deploy / declare validation)

| Entrypoint             | Signature                                                           | Description                                                                                                       |
| ---------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `__validate_deploy__`  | `(class_hash: felt252, salt: felt252, public_key: u256) -> felt252` | Validates the `DeployAccount` transaction over its tx hash, the same scheme as `__validate__`. Returns `'VALID'`. |
| `__validate_declare__` | `(class_hash: felt252) -> felt252`                                  | Validates a `Declare` transaction over its tx hash. Returns `'VALID'`.                                            |

### `IUpgradeable` (class replacement)

| Entrypoint | Signature                     | Description                                                                                                                                                                                                                                                                                             |
| ---------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `upgrade`  | `(new_class_hash: ClassHash)` | Self-authorized `replace_class` (see _Upgrades_). Asserts `caller == self` (`'NOT_SELF'`) and a non-zero class (`'ZERO_CLASS'`), vets the target with the `identity()` library-call guard (`'BAD_IDENTITY_RET'` / `'NOT_SOL_ACCOUNT'`), swaps, emits `Upgraded`, then runs the required migration hook. |

### `IVersionedUpgrade` (versioning + migration)

| Entrypoint              | Signature             | Description                                                                                                                                                                                                                                               |
| ----------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`               | `() -> u32`           | Returns this class's on-chain `VERSION` (non-gating metadata; see _Versioning_).                                                                                                                                                                          |
| `identity`              | `() -> felt252`       | Returns the frozen const `SOL_ACCOUNT_IDENTITY` (`'solana_account'`); the upgrade guard library-calls this on a target class.                                                                                                                             |
| `execute_after_upgrade` | `(from_version: u32)` | Post-upgrade migration hook. Self-only (`'NOT_SELF'`) and gated by the `migration_in_progress` flag (`'NOT_IN_MIGRATION'`), so it is reachable only from within an `upgrade`. Idempotently re-registers the SRC5 ids; treats `from_version` as untrusted. |

### Embedded OpenZeppelin components

The account embeds OZ's `SRC5Component` (introspection) and `SRC9Component` (SNIP-9 v2
outside execution). Their entrypoints are part of this class:

| Entrypoint                         | Signature                                                                                 | Description                                                                                                                                                              |
| ---------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `supports_interface`               | `(interface_id: felt252) -> bool`                                                         | SRC5 introspection. Returns `true` for `ISRC5_ID` (answered unconditionally), and for `ISRC6_ID` and `ISRC9_V2_ID` (both registered by the constructor).                 |
| `execute_from_outside_v2`          | `(outside_execution: OutsideExecution, signature: Span<felt252>) -> Array<Span<felt252>>` | SNIP-9 v2 sponsored entry path: a relayer submits calls the owner pre-signed and pays the fees, while the calls execute as the account (see _SNIP-9 outside execution_). |
| `is_valid_outside_execution_nonce` | `(nonce: felt252) -> bool`                                                                | Returns `true` while the given outside-execution nonce is unused; the view a relayer polls before submitting.                                                            |

The two registered interface ids (copied from `openzeppelin_interfaces`, the same felts the
contract tests assert against):

| Id            | Value                                                               |
| ------------- | ------------------------------------------------------------------- |
| `ISRC6_ID`    | `0x2ceccef7f994940b3962a6c67e0ba4fcd37df7d131417c604f91e03caecc1cd` |
| `ISRC9_V2_ID` | `0x1d1144bb2138366ff28d8e9ab57456b1d332ac42196230c3a602003c89872`   |

### Constants

| Constant               | Type      | Value              | Meaning                                                                                                                          |
| ---------------------- | --------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `SOL_ACCOUNT_IDENTITY` | `felt252` | `'solana_account'` | The frozen identity every sol_account class self-reports through `identity()`; the upgrade guard requires a target to return it. |
| `VERSION`              | `u32`     | `1`                | This class's on-chain version, exposed through `version()` as non-gating metadata.                                               |

## Events

| Event               | Fields                      | When                                                                  |
| ------------------- | --------------------------- | --------------------------------------------------------------------- |
| `SignerInitialized` | `{ public_key: u256 }`      | Once, from the constructor, when the immutable Ed25519 signer is set. |
| `Upgraded`          | `{ class_hash: ClassHash }` | On each `upgrade`, carrying the NEW class hash.                       |
| `SRC5Event` (flat)  | OZ `SRC5Component::Event`   | Interface registration from SRC5.                                     |
| `SRC9Event` (flat)  | OZ `SRC9Component::Event`   | SNIP-9 outside-execution activity.                                    |

`Upgraded` carries only the new class hash. A monitor that missed an earlier `Upgraded` (or
the original deploy) therefore cannot reconstruct the full from-to chain from a single event
in isolation; recover the prior class from the preceding event or the deploy, or by reading
`get_class_hash_at` at the block before the upgrade.

## Interacting with a deployed account

### Reading account state

The views are plain `starknet.js` calls against a provider (reads take no signature and no
paymaster). This snippet reads the signer, the version, the self-reported identity, and
SNIP-9 support from a deployed account:

```ts
import { RpcProvider, shortString } from "starknet";

const provider = new RpcProvider({ nodeUrl: "https://your-sepolia-rpc-url" });
const account = "0x..."; // a deployed sol_account address

// ISolAccount.get_public_key() -> u256, returned as [low, high] felts
const [pkLow, pkHigh] = await provider.callContract({
  contractAddress: account,
  entrypoint: "get_public_key",
});
const publicKey = BigInt(pkLow) + (BigInt(pkHigh) << 128n);

// IVersionedUpgrade.version() -> u32
const [version] = await provider.callContract({
  contractAddress: account,
  entrypoint: "version",
});

// IVersionedUpgrade.identity() -> felt252 ('solana_account')
const [identity] = await provider.callContract({
  contractAddress: account,
  entrypoint: "identity",
});
const identityText = shortString.decodeShortString(identity); // "solana_account"

// SRC5 supports_interface(ISRC9_V2_ID) -> bool
const ISRC9_V2_ID = "0x1d1144bb2138366ff28d8e9ab57456b1d332ac42196230c3a602003c89872";
const [supportsSnip9] = await provider.callContract({
  contractAddress: account,
  entrypoint: "supports_interface",
  calldata: [ISRC9_V2_ID],
});
const isSnip9 = BigInt(supportsSnip9) === 1n;
```

### Writing (sponsored only)

Every state-changing path runs paymaster-sponsored through `@starkware-libs/anystark-core`'s
`SolanaAsStarknetAccount`, which wraps the owner's Ed25519 signature in the message-binding
scheme above and submits it through the configured SNIP-29 paymaster. Construct it with a
`paymaster`, then use `account.execute(calls)` for ordinary calls and
`account.upgrade(classHash)` for a class replacement (the upgrade runs sponsored, exactly
like every other operation):

```ts
import {
  SolanaAsStarknetAccount,
  resolveDeployClassHash,
  CHAIN_IDS,
} from "@starkware-libs/anystark-core";

const account = new SolanaAsStarknetAccount({
  signer, // SolanaSigner: { pubkey, signBytes }
  rpcUrl: "https://your-sepolia-rpc-url",
  classHash: resolveDeployClassHash({ chainId: CHAIN_IDS.sepolia }),
  paymaster: { nodeUrl: "https://your-paymaster-url" }, // REQUIRED
});

// Ordinary calls, sponsored:
await account.execute([{ contractAddress: "0x...", entrypoint: "transfer", calldata: [] }]);

// Class upgrade, also sponsored:
await account.upgrade("0x..."); // a declared, identity-compliant sol_account class hash
```

See `@starkware-libs/anystark-core` for the full account, signer, and paymaster surface.

## Class hash (fund-safety critical)

A Phantom user's Starknet address is **counterfactually derived** from this contract's
**class hash**:

```
salt    = poseidon([pk.low, pk.high])
address = calculateContractAddressFromHash(salt, CLASS_HASH, [pk.low, pk.high], 0)
```

So the class hash must be pinned and identical everywhere (TS derivation, the on-chain
class, the per-network `@starkware-libs/anystark-core` class-hash map). A mismatch derives a **different,
uncontrollable address** - funds bridged there are unrecoverable.

The class hash is fixed by the compiled Sierra, which embeds the crate path
`sol_account::SolAccount` **and the full implementation logic** (inline Ed25519
verification, the `IUpgradeable`/`replace_class` entrypoint, SRC5 introspection, and SNIP-9
outside execution via OZ's `SRC9Component` — all of these inline into the Sierra and
co-determine the hash). For the current implementation (built with **scarb 2.18.0** and
garaga **pinned to `=1.1.0`** in `Scarb.toml`, matching the committed `Scarb.lock`) the
class hash is:

```
0x07ec6a68af00a71582569f94ee3ec85eb530365a06b6b7cefbef8f2f8f6c2288
```

This value is **not hand-maintained** — recompute it from the build artifact and treat the
recomputed value as authoritative:

```bash
scarb build
starkli class-hash target/dev/sol_account_SolAccount.contract_class.json
# or starknet.js: hash.computeContractClassHash(contract_class_json)
```

Any change to the contract logic, the crate path, or the resolved garaga version changes
this hash - re-declare on each target network and update the `@starkware-libs/anystark-core` class-hash map whenever
it changes.

### `@starkware-libs/anystark-core` class-hash map (kept in sync)

The TS SDK pins this class hash:

- `SOL_ACCOUNT_CLASS_HASHES` in `packages/core/src/key_to_address.ts` (a flat
  `Record<chain, string>`: one frozen class hash per chain, resolved via the
  `resolveDeployClassHash` helper)
- `EXPECTED.address` in `packages/core/src/key_to_address.test.ts` (the locked derivation
  vector; `low`/`high`/`salt` are unchanged, only `address` moves with the class hash)

This is guarded by `packages/core/src/class_hash.test.ts`, which recomputes the hash from
the committed compiled artifact (`packages/core/src/__fixtures__/sol_account.contract_class.json`)
and asserts it equals the chain's pinned hash in the map. The hash is frozen: counterfactual
account addresses derive from it, so the same value is fixed across the contract source, the
committed fixture, the on-chain declared class, and this map (the `sepolia class hash (frozen
literal lock)` test in `key_to_address.test.ts` locks the literal too).
The map-vs-on-chain match is exercised separately by the opt-in live e2e. The SDK write
paths that consume these hashes (`SolanaAsStarknetAccount` and its sponsored `upgrade`) live
in `@starkware-libs/anystark-core`; see _Interacting with a deployed account_ above.

## Message binding (base64 + optional readable label)

Phantom signs UTF-8 text, so the account binds the owner's Ed25519 signature to the
operation hash (the tx hash for `__validate*__`, or the SNIP-12 outside-execution hash for
the sponsored path) through the **text the wallet displays**. The signed message's **fixed
trailing 44 bytes** are the standard **base64** (alphabet `A-Z a-z 0-9 + /`, exactly one
`=` pad) of the hash's **32 big-endian bytes**. An optional human-readable **label** may
prefix the hash, separated by a single `'\n'`, so the wallet popup shows the user what they
approve.

The validation core decodes **only the last 44 bytes** and compares them **u256-exact** to
the operation hash - never a delimiter search. A label is dapp-controlled text and may itself
contain `'\n'` or base64-looking runs, so only the trailing window is authoritative; a
second hash embedded anywhere in the label is inert bytes. The base64 decode is canonical
(the final `=` and the zero pad bits of the second-to-last char are both asserted), so each
hash has exactly one accepted encoding, and the u256-exact compare avoids mod-Stark-prime
aliasing (a hash congruent mod the Stark prime cannot alias).

**The label is ADVISORY.** Ed25519 covers every byte, so nobody can alter a signed label
after the fact - but the chain does **NOT** check the label against the calls. It adds
display honesty for honest dapps and zero authority for dishonest ones (a malicious dapp
can already choose the calls the user blind-signs). Wallets, auditors, and users must never
treat the label as something the chain enforced.

**Readable-label length limits and gas tradeoff.** garaga hashes `SHA-512(R‖A‖msg)`
on-chain over `64 + msg_len` bytes plus ≥17 padding bytes, in 128-byte blocks, on **every**
validation (so this cost recurs per transaction, forever):

| Label size    | `msg_len` | SHA-512 blocks | Notes                                                                                                |
| ------------- | --------- | -------------- | ---------------------------------------------------------------------------------------------------- |
| none          | 44        | 1              | Cheapest, but **NOT recommended**: the user signs an opaque blob, so the wallet popup is unreadable. |
| ≤ 130 chars   | ≤ 175     | 2              | A full sentence, e.g. `"AppName: transfer 25 USDC to alice.strk"`.                                   |
| 131-258 chars | ≤ 303     | 3              | The maximum; `MAX_MSG_LEN = 303` (the 3-block ceiling `64 + 303 + 17 = 384 = 3·128`).                |
| > 258 chars   | > 303     | -              | Rejected: `'MSG_TOO_LONG'` on-chain, and before signing in the SDK.                                  |

The label budget is `MAX_MSG_LEN − 44 − 1 = 258` bytes (UTF-8 bytes, so multibyte chars
count per byte). Each extra SHA-512 block is roughly **+5.3M sierra gas on every
validation** (measured: the no-label happy-path test spends ~13.4M L2 gas, the 2-block
labeled path ~18.9M, the 3-block max-label path ~25.4M). There is no gas difference between
a 3-char and a 130-char label (both are 2 blocks), so **use the block you already bought**:
a label should be a succinct full sentence or nothing. The SDK default is **no label**
(single block, cheapest); dapps opt in via `signingLabel` (see `@starkware-libs/anystark-core`).

**Malformed input is handled by a non-panicking validation core** (never a raw unwrap /
underflow / out-of-bounds panic on attacker-controlled calldata). The core reports each
rejection as a named reason: `'BAD_SIG_ENCODING'` (the bundle does not deserialize as an
`EdDSASignatureWithHint` - a short span, a `msg_len` that is not a `u32`, or a message felt
that is not a byte), `'MSG_TOO_SHORT'` (< 44, checked before the trailing-window subtraction
so it cannot underflow), `'MSG_TOO_LONG'` (> 303, capping the message length fed to garaga's
SHA-512 hashing), `'BAD_MSG_SEPARATOR'` (labeled message without a `'\n'` before the hash),
`'BAD_B64_CHAR'` / `'BAD_B64_PAD'` (non-alphabet char, missing `=`, or non-zero pad bits),
`'MSG_NOT_BOUND'` (decoded hash ≠ operation hash), and `'INVALID_SIG'` from garaga. A
signature by the wrong key surfaces as `'INVALID_SIG'`: garaga verifies against the account's
stored signer, so signer binding is structural rather than a separate calldata comparison.

The two callers turn that reason into the surface each needs. On the **transaction-validation
path** (`__validate__` / `__validate_deploy__` / `__validate_declare__`) the reason is the
**named revert** the protocol sees. `is_valid_signature` instead **returns `0`** for every
one of these rejections (SNIP-6 conformance, matching OZ accounts) and `'VALID'` only on
success. **Honest limit:** garaga's verifier can still panic **internally** when a bundle's
MSM / sqrt hints are self-inconsistent (a hint-tampered bundle), and no on-chain code can
catch that panic; so `is_valid_signature` is non-reverting for every rejection this contract
detects, while a hint-tampered bundle still reverts inside garaga.

Because the sponsored path (SNIP-9) validates by self-calling `is_valid_signature` and
asserting the result is `'VALID'`, a rejected sponsored signature surfaces as OZ's generic
`'SRC9: invalid signature'`, not the specific inner reason (see _Outside execution_).

### Signature wire format

The transaction `signature` field (and the `signature` argument to `is_valid_signature` and
`execute_from_outside_v2`) carries a serialized garaga `EdDSASignatureWithHint`, whose felt
order is fixed by garaga's `Serde` derivation:

```
[ Ry.low, Ry.high, s.low, s.high, msg_len, msg[0..msg_len), msm_hint..., sqrt hints... ]
     0        1       2      3        4          5 ...
```

- The bundle carries **no public key**: the account verifies against its **stored** signer
  (garaga's `Py_twisted`, read from storage), so signer binding is structural rather than
  parsed from calldata.
- `msg_len` (the signed message's byte length) is at felt 4, and the message bytes start at
  felt 5. Each message felt holds one byte, which `Serde` narrows to a `u8` on decode.
- The remaining felts are garaga's verification hints (the multi-scalar-multiplication hint
  and the square-root hints).

`@starkware-libs/anystark-core`'s `buildEddsaSignatureFelts` produces this exact layout from the raw
Ed25519 signature and message. The validation core deserializes the bundle, reads the message
as a typed `Span<u8>` straight off the decoded struct to bind it, then hands the bundle plus
the stored signer to garaga's verifier.

## Versioning

Every published class carries an on-chain `VERSION` (a `u32`) exposed through the
`version()` view (interface `IVersionedUpgrade`). This class is **v1**, the single frozen
class hash pinned per chain in the SDK; numbering starts at `1`.

`version()` is **non-gating metadata** in v1: `upgrade` does **not** order releases by it (the
`identity()` guard is the sole on-chain upgrade gate). It is exposed as a view and passed to
the post-upgrade migration hook as `from_version`. There is deliberately **no on-chain
downgrade protection** — a future versioned scheme, if needed, can only start from a future
class forward (see _Upgrades_).

## Upgrades

Upgrades go through the native `replace_class` path: the `IUpgradeable::upgrade` entrypoint
is **self-authorized** (asserts `caller == self`, so it is only reachable via a signed
`__execute__` call back into the account itself — only the Ed25519 owner can invoke it; no
separate admin key), rejects the zero class (`'ZERO_CLASS'`), and then vets the target class
with a single **identity guard** before swapping, running a **required migration hook** after.
Upgrade is **manual and entirely user-chosen**; the identity guard is **mistake prevention,
not a security boundary**.

**On-chain anti-brick protections** (exactly two - see the honest scope note below):

1. **sol_account identity** - the target's `identity()` (a pure-`const` library call, run
   _before_ any state change) must equal `SOL_ACCOUNT_IDENTITY` (`'solana_account'`), else
   `'NOT_SOL_ACCOUNT'`. This mirrors Argent's `get_name()` identity check: only sol_account
   classes self-report this const, so a foreign class is rejected. A class **without** an
   `identity()` entrypoint makes the library call itself fail, reverting the upgrade — so this
   single call is **also the target-declared probe**: an undeclared class, or a declared class
   lacking `identity()`, cannot be installed. It is deliberately a `const`, **not** a
   storage-backed `supports_interface` (a `supports_interface` library call would run against
   **this** account's storage and answer for the **current** class, proving nothing about the
   target). Pinned by `upgrade_rejects_wrong_identity` / `upgrade_rejects_absent_identity`.
   This is a **mistake** guard (wrong-project hash, typo, undeclared class), **not** a defense
   against a malicious class that lies in `identity()`; the owner must validate targets
   off-chain.
2. **A required migration hook** - immediately after `replace_class`, `upgrade` self-calls
   `execute_after_upgrade(from_version)` on the **new** class (passing this old class's
   `VERSION`). A target that lacks `execute_after_upgrade` (or whose hook panics) makes that
   self-call fail, and the whole upgrade **reverts atomically** — the `replace_class` rolls
   back and the account stays on its current class, never half-upgraded. This is pinned by the
   `upgrade_reverts_atomically_when_migration_hook_panics` / `..._absent` tests.

**No downgrade / same-version protection.** `upgrade` accepts **any** identity-compliant class,
including an **older** one or the **same** class (a no-op re-install). Downgrade protection is
intentionally dropped for v1; a future versioned scheme starts from a future class forward.

> **Honest scope: `upgrade` does NOT verify the target "is an account".** There is no sound
> on-chain way to confirm, before the swap, that a target class has a working
> `__validate__` / `__execute__`. A storage-backed `supports_interface` library call would run
> against **this** account's storage and answer for the **current** class, not the target, so it
> proves nothing. The owner therefore **MUST declare and dry-run-validate any new class
> off-chain before upgrading** - the on-chain guard only catches a wrong identity and the
> missing-hook footgun, not a class that is identity-correct but not a working account.

**Forbidden-call guard (`execute_after_upgrade` is not a user-callable multicall).** The
migration hook is self-only and reachable **only** as `upgrade`'s internal post-`replace_class`
self-call. But `__execute__` dispatches owner-signed calls back into the account with
`caller == self`, so a user-signed multicall targeting the `execute_after_upgrade` selector
would otherwise satisfy the hook's self-check. `__execute__` therefore rejects any `Call`
whose selector is `execute_after_upgrade` with `'FORBIDDEN_CALL'` (Argent's forbidden-call
pattern), closing the replay vector for future **non-idempotent** hooks (v1's hook is
idempotent, but the invariant must hold for every version). Pinned by
`execute_rejects_direct_migration_hook_call`. (This covers the self-execute multicall path;
the SNIP-9 `SRC9Component` executes its own calls and is outside this entrypoint's scope.)

**Release invariant (every sol_account class MUST retain a working `upgrade()`).** Because the
fleet upgrades **per account, forward only**, any published class that dropped or broke
`upgrade()`, or that stopped self-reporting `SOL_ACCOUNT_IDENTITY`, would strand every account
on it - no further upgrade could ever be signed. This is a **release-discipline invariant**,
enforced at release time by `upgrade_target_is_itself_upgradeable`: it deploys v1, upgrades
into the compliant next version, then drives **that** class's own `upgrade()` into a further
compliant version, proving the target is itself an upgradeable sol_account end to end (identity
guard + migration hook + preserved signer slot). Any new class must pass this test before it
ships.

**Migration hook details.** Because `replace_class` takes effect for subsequent calls within the
same transaction (the same pattern OZ's `upgrade_and_call` relies on), the self-call routes to
the **new** class's implementation, and `upgrade` passes the **old** class's `VERSION` as
`from_version`. `execute_after_upgrade` is **self-only** (asserts `caller == self`) and further
gated by a path-independent `migration_in_progress` storage flag that `upgrade` sets around the
self-call and clears after, so the hook is reachable **only** from within an upgrade on any
route (multicall or SNIP-9). This class's own hook **idempotently re-registers the SRC5 interface
ids the constructor sets** (`ISRC6_ID` and, via the SRC9 initializer, `ISRC9_V2_ID`), which closes
the SRC5-discovery caveat below for any account upgrading _into_ a class that follows this pattern.

> **`from_version` is untrusted (forward constraint for future versions).**
> `execute_after_upgrade` is a public entrypoint the owner can self-call standalone with **any**
> `from_version` (the gates are `caller == self` and the migration flag), so this v1 hook
> deliberately **ignores** it and stays fully idempotent — a standalone self-call outside an
> upgrade is rejected `'NOT_IN_MIGRATION'` (pinned by
> `execute_after_upgrade_direct_self_call_rejected`). **Any** future version's hook MUST
> likewise treat `from_version` as untrusted and remain idempotent / replay-safe, and must never
> use it to gate a one-time state transition.

**Trust model.** `upgrade` is **owner-authorized**: the identity guard is **anti-footgun, not
anti-owner**. It runs the target class's `identity()` code via library call in this account's
context, so a malicious or buggy target can only **lie about its own return value** — it cannot
mutate state, because we read only the returned felt and `replace_class` runs strictly after the
guard passes. Since only the Ed25519 owner can reach `upgrade` at all, the residual risk is
purely the owner bricking their own account with a class that clears the identity guard but is not
a working account — which only the off-chain dry-run validation above can catch.

Because the verification logic lives in this class, **every logic change changes the class
hash** (see above) — this upgrade path does _not_ preserve the class hash, and is only safe
for already-deployed accounts, whose storage and address are unaffected by a class swap.

`replace_class` preserves the storage tree, so the **storage-layout invariant** is
fund-critical: every replacement class MUST keep a `public_key: u256` field at the same
(name-derived) storage address. Starknet storage addresses are derived from the variable's
name (`sn_keccak("public_key")`), not from declaration order, so the slot is preserved iff
the field keeps the same name and type — storage must stay append-only (never rename,
retype, or remove `public_key`) — that signer is what derives the user's address; a V2 that
moves it would orphan the root signer. This is enforced
by convention and by the `upgrade_preserves_signer_slot` regression test; it cannot be
enforced on-chain. Upgrading to a class that is not declared on the target network, or that
does not correctly implement validation, **permanently bricks** the account — declare and
dry-run-validate any new class before upgrading.

The `upgrade_*` tests rely on a specific snforge behavior: they trigger the swap by calling
the account's own `upgrade()` entrypoint (an **in-contract** `replace_class_syscall`, not the
`replace_bytecode` cheatcode), and snforge observes that swap so follow-on dispatcher calls to
the same address reroute to the new class within the same test. The replacement class is
`declare()`d first because snforge requires the new class to be declared for it to execute.

### Scope: upgrades are post-deployment only (the deploy class is frozen)

`replace_class` can only run on a contract that already exists, so it cannot change the class
an _undeployed_, counterfactual account is born with. A counterfactual account is necessarily
deployed with (and its `__validate_deploy__` runs) the class hash pinned in `@starkware-libs/anystark-core`, and
that first validation cannot be upgraded away (Starknet forbids reading external/global state
during validation, and there is no code running before deploy to swap the class). So:

- For **deployed** accounts, `upgrade` swaps the verification logic with no change to the
  address — that is the win.
- The **deploy class is effectively frozen**: a bug in it that blocks the _first_
  (deploy-time) validation cannot be fixed by `upgrade` for accounts that have not deployed
  yet. The only remedy is shipping a new class → new class hash → new derived addresses,
  which strands funds already bridged to the old addresses. The pinned deploy class therefore
  carries the same fund-safety weight as the address derivation itself and must be audited as
  such. (This limit is inherent to counterfactual deployment on Starknet; it is identical for
  a `replace_class` design, a thin-proxy design, or a beacon design.)

## SNIP-9 outside execution

The account embeds OZ's `SRC9Component` (SNIP-9 v2): a relayer or paymaster — e.g. SNIP-29
dapp-funded sponsorship — submits **its own** transaction that calls
`execute_from_outside_v2(outside_execution, signature)` on the account and pays its fees,
while the signed calls execute **as the account** (targets observe the account as caller).
This is a second, sponsored entry path only; the account still self-executes normally via
`__execute__`.

**Signature.** The same garaga Ed25519 `EdDSASignatureWithHint` bundle as a regular
transaction - the only difference is _which hash_ the signed message encodes. Instead of the
transaction hash, the owner signs the base64 message (see _Message binding_) of `h`, where
`h` is the **SNIP-12 rev-1** typed-data hash of the `OutsideExecution` struct (domain
`'Account.execute_from_outside'`, version `2`), which folds in the account address and the
chain id. The existing message-binding step verifies it unchanged: OZ's component hashes the
request and self-calls `is_valid_signature`.

**Producing the hash (SDK guidance).** Use starknet.js's outside-execution helpers
(`outsideExecution.getTypedData` + `typedData.getMessageHash`) — verified to match OZ's
Cairo `get_message_hash` byte-for-byte by the locked test vector, whose generator
(`packages/core/scripts/gen_snip9_vector.mjs`) hard-fails on any TS↔Cairo mismatch.
⚠️ **Never hand-roll the SNIP-12 hash**: the `OutsideExecution` type string encodes
`Execute After` / `Execute Before` as `u128` even though the struct fields are `u64`, so an
"obvious" hand-rolled type hash silently derives a different, invalid hash.

**Guards** (all enforced by the component before anything executes):

- **Caller** — the signed `caller` field binds who may submit; the `'ANY_CALLER'` sentinel
  opts out of the restriction.
- **Time window** — strict on both ends: `execute_after < now < execute_before`.
- **Nonce** — a per-account map of arbitrary felts (independent of the protocol nonce, not
  sequential); each signed nonce executes at most once, and
  `is_valid_outside_execution_nonce` is the view a relayer polls before submitting.
- **Signature**, validated via a dispatcher self-call into `is_valid_signature`, which OZ's
  SRC9 asserts equals `'VALID'`. Because `is_valid_signature` is SNIP-6-conforming (it returns
  `0` for every rejection it detects rather than reverting), a rejected sponsored signature
  surfaces as OZ's generic `'SRC9: invalid signature'`, **not** the specific inner reason
  (`'MSG_NOT_BOUND'`, `'INVALID_SIG'`, `'BAD_SIG_ENCODING'`, and the rest). The specific
  reason is still the revert code on the direct transaction-validation path. A hint-tampered
  bundle is the exception that reverts inside garaga before OZ's assert is reached.

**Class-hash implications.** The SRC9 entrypoints (and SRC5's `supports_interface`) are
part of the compiled Sierra, so they are **included in the class hash**. As with any logic
change (see _Class hash_ above and the NOTE in `Scarb.toml`): re-declare on every target
network and update the `@starkware-libs/anystark-core` class-hash map and its locked derivation vector.

**Upgrade caveat (SRC5 discovery) - mostly addressed.** `ISRC6_ID` and `ISRC9_V2_ID` are
registered by the **constructor**, and constructors do not re-run on `replace_class`. This
class closes that gap for the forward path: its self-only `execute_after_upgrade` migration
hook (see _Upgrades_ above) **idempotently re-registers both ids** on every guarded upgrade
into a class that follows this pattern, so a paymaster probing
`supports_interface(ISRC9_V2_ID)` sees them registered after the swap. The **residual** caveat
is legacy-only: an account still sitting on a **pre-hook** class (whose `upgrade` is a bare
`replace_class` with no migration hook) upgraded into this one gets the SRC9 entrypoints but
not the SRC5 registrations, because the old class never invokes the hook and the constructor
does not re-run. Nothing can retrofit a hook onto a class that already lacks one; such accounts
must call `execute_from_outside_v2` directly (it works) or re-register via a future
owner-driven path. This is pinned by `upgrade_from_pre_snip9_leaves_src5_unregistered`.

## Error reference

Execution and upgrade rejections are named reverts; signature rejections are named reasons
produced by the validation core. All are short-string felts; the constructor uses `assert!`
string messages. The subsections above explain the rationale; this table is the greppable
summary.

### Signature validation

Each row is the reason the validation core reports. On the transaction-validation path
(`__validate__`, `__validate_deploy__`, `__validate_declare__`) it is the **named revert** the
protocol sees. Through `is_valid_signature` (and therefore the SNIP-9 check, which self-calls
it) the same rejections instead **return `0`**, so the sponsored path surfaces the generic
`'SRC9: invalid signature'` from OZ rather than these reasons.

| Reason                | Condition                                                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'BAD_SIG_ENCODING'`  | The bundle does not deserialize as an `EdDSASignatureWithHint`: a short span, a `msg_len` that is not a `u32`, or a message felt that is not a byte. |
| `'MSG_TOO_SHORT'`     | `msg_len < 44` (shorter than the base64 hash tail).                                                                                                  |
| `'MSG_TOO_LONG'`      | `msg_len > 303` (`MAX_MSG_LEN`).                                                                                                                     |
| `'BAD_MSG_SEPARATOR'` | A labeled message (`msg_len > 44`) has no `'\n'` immediately before the base64 tail.                                                                 |
| `'BAD_B64_CHAR'`      | A byte in the base64 window is outside the standard alphabet.                                                                                        |
| `'BAD_B64_PAD'`       | The final group is missing its single `'='` pad, or its pad bits are non-zero (non-canonical encoding).                                              |
| `'MSG_NOT_BOUND'`     | The decoded 32-byte hash does not equal the operation hash.                                                                                          |
| `'INVALID_SIG'`       | garaga's Ed25519 verification fails, including a signature by any key other than the stored signer.                                                  |

### Execution and upgrade

| Revert               | Entrypoint                         | Condition                                                                           |
| -------------------- | ---------------------------------- | ----------------------------------------------------------------------------------- |
| `'INVALID_CALLER'`   | `__execute__`                      | The caller is not the protocol (caller address is non-zero).                        |
| `'FORBIDDEN_CALL'`   | `__execute__`                      | A `Call` in the multicall targets the `execute_after_upgrade` selector.             |
| `'NOT_SELF'`         | `upgrade`, `execute_after_upgrade` | The caller is not the account itself.                                               |
| `'ZERO_CLASS'`       | `upgrade`                          | The target class hash is zero.                                                      |
| `'BAD_IDENTITY_RET'` | `upgrade`                          | The target's `identity()` return cannot be deserialized as a felt.                  |
| `'NOT_SOL_ACCOUNT'`  | `upgrade`                          | The target's `identity()` returns a value other than `SOL_ACCOUNT_IDENTITY`.        |
| `'NOT_IN_MIGRATION'` | `execute_after_upgrade`            | The hook was called outside an upgrade (the `migration_in_progress` flag is false). |

An undeclared target class, or one lacking an `identity()` entrypoint, fails at the
`library_call_syscall` itself and reverts the `upgrade` before the identity comparison, so it
surfaces as the syscall failure rather than `'NOT_SOL_ACCOUNT'`.

### Constructor

| Revert                                        | Condition                                  |
| --------------------------------------------- | ------------------------------------------ |
| `"public_key must be non-zero"`               | The `public_key` argument is zero.         |
| `"public_key is not a canonical Ed25519 key"` | The key's y coordinate is `>= 2^255 - 19`. |
