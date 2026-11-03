// ─── sol_account ───
// A Starknet account whose root signer is a Phantom / Solana Ed25519 key.
//
// Design:
//   - The stored signer is the 32-byte Ed25519 public key read as a little-endian
//     u256. (An Ed25519 pubkey encodes the y coordinate of the key point on the
//     twisted Edwards curve plus x's sign bit, so garaga's EdDSA API calls this
//     exact u256 `Py_twisted`.)
//   - Phantom signs RAW MESSAGE BYTES (`signMessage`); garaga's Ed25519 verifier
//     hashes SHA-512(R‖A‖msg) internally, so validation verifies the bytes and
//     BINDS them to the Starknet transaction hash (replay / calldata protection).
//     The signed message's FIXED TRAILING 44 bytes are the standard base64 of the
//     32 big-endian bytes of the operation hash, optionally prefixed by a readable
//     label + '\n' so the wallet popup shows the user what they approve. See the
//     binding notes above `validate_signature` for the length/gas tradeoff and the
//     fixed-trailing-window (never delimiter-search) rationale.
//   - The tx `signature` field carries a serialized garaga EdDSASignatureWithHint
//     (Ry, s, msg, msm_hint, sqrt hints), generated off-chain. Validation deserializes
//     the bundle, binds its signed message to the operation hash, then hands the bundle
//     plus THIS account's stored signer (Py_twisted, read from storage) to garaga's
//     verifier. Signer binding is therefore structural: the key garaga checks against
//     is the stored one, never parsed from calldata.
//   - Counterfactual deployment: the address is deterministic from
//     (class_hash, salt = poseidon([pk.low, pk.high]), [pk.low, pk.high], deployer=0),
//     so CCTP can mint to it before any code is deployed.
//   - Upgradeable: a self-authorized `upgrade(new_class_hash)` swaps this class via
//     `replace_class` (see `IUpgradeable`). Verification logic lives in THIS class, so
//     an upgrade changes the class hash and is address-stable only for already-deployed
//     accounts; new accounts still derive from the class hash pinned in `@starkware-libs/anystark-core`.
//   - Sponsored execution: SNIP-9 `execute_from_outside_v2` (OZ SRC9Component) lets a
//     relayer submit calls the user pre-signed and pay the fees — the same Ed25519
//     scheme, signed over the SNIP-12 request hash instead of the tx hash.

use starknet::ClassHash;
use starknet::account::Call;

#[cfg(test)]
mod test_sol_account;

#[cfg(test)]
mod test_mocks;

#[cfg(test)]
mod test_outside_execution;

#[starknet::interface]
pub trait ISolAccount<TState> {
    // SNIP-6
    fn __validate__(self: @TState, calls: Array<Call>) -> felt252;
    fn __execute__(ref self: TState, calls: Array<Call>) -> Array<Span<felt252>>;
    fn is_valid_signature(self: @TState, hash: felt252, signature: Array<felt252>) -> felt252;
    // Read the stored Ed25519 signer (pubkey bytes as a little-endian u256).
    fn get_public_key(self: @TState) -> u256;
}

#[starknet::interface]
pub trait IDeployValidate<TState> {
    fn __validate_deploy__(
        self: @TState, class_hash: felt252, salt: felt252, public_key: u256,
    ) -> felt252;
    fn __validate_declare__(self: @TState, class_hash: felt252) -> felt252;
}

#[starknet::interface]
pub trait IUpgradeable<TState> {
    // Replace this account's class. Self-authorized: only the account itself
    // (via a signed __execute__ call back into this address) may call it. Before the
    // swap the target class is vetted by an identity() library-call guard (it must
    // self-report the sol_account identity), and after the swap a required migration
    // hook must run (a target lacking identity() or execute_after_upgrade reverts the
    // upgrade); see the impl.
    fn upgrade(ref self: TState, new_class_hash: ClassHash);
}

// The versioned-upgrade surface. Kept separate from IUpgradeable so a legacy
// (bare-upgrade) class need not implement it, while every sol_account class does.
#[starknet::interface]
pub trait IVersionedUpgrade<TState> {
    // On-chain version of THIS account class, exposed as NON-GATING metadata. `upgrade`
    // does NOT order releases by it (the identity() guard is the sole on-chain upgrade
    // gate); it is kept as a view and passed to the migration hook as `from_version`.
    fn version(self: @TState) -> u32;
    // Post-upgrade migration hook. `upgrade` invokes it on the NEW class right after
    // replace_class, passing the OLD class's version as `from_version`. Self-only
    // (asserts caller == self); never call it externally.
    fn execute_after_upgrade(ref self: TState, from_version: u32);
    // Self-reported sol_account identity (a pure const). Identity guard: see
    // SOL_ACCOUNT_IDENTITY docs.
    fn identity(self: @TState) -> felt252;
}

// sol_account identity, self-reported by identity(). The `upgrade` guard library-calls the
// TARGET class's identity() and requires it to equal this const, so only sol_account classes
// are accepted as upgrade targets; a target reporting anything else (or lacking identity()
// entirely) reverts 'NOT_SOL_ACCOUNT'. This mirrors Argent's get_name() identity check.
// Deliberately a pure const, NOT a storage-backed supports_interface: a supports_interface
// library call would execute against THIS account's storage and answer for the CURRENT class,
// proving nothing about the target (that would be a tautology). A pure const is instead read
// from the TARGET class's own code, so the library call reads the target's real value. This
// guard is MISTAKE prevention (wrong-project hash, typo, undeclared class), NOT a security
// boundary of any kind: library_call_syscall runs the target class's code in THIS account's
// storage context with no sandbox, so a malicious target's identity() can freely mutate this
// account's state or act as the account while it runs. A wrong-identity return reverts the
// tx and rolls back any such mutation, so the guard catches an HONEST target that self-reports
// the wrong felt; it does NOT stop a target that lies (returns this const) and mutates. The
// owner MUST therefore fully vet new_class_hash off-chain. The same library call doubles as
// the target-declared probe: an undeclared class makes the syscall itself fail, reverting the
// upgrade before any state change.
// FROZEN protocol constant: every future sol_account class MUST return it, or v1 accounts
// cannot upgrade to it.
pub const SOL_ACCOUNT_IDENTITY: felt252 = 'solana_account';

#[starknet::contract(account)]
pub mod SolAccount {
    use core::num::traits::{SaturatingSub, Zero};
    use garaga::signatures::eddsa_25519::{EdDSASignatureWithHint, is_valid_eddsa_signature};
    use openzeppelin_account::extensions::SRC9Component;
    use openzeppelin_interfaces::accounts::ISRC6_ID;
    use openzeppelin_introspection::src5::SRC5Component;
    use starknet::account::Call;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::syscalls::{call_contract_syscall, library_call_syscall, replace_class_syscall};
    use starknet::{
        ClassHash, SyscallResultTrait, get_caller_address, get_contract_address, get_tx_info,
    };
    use super::{IDeployValidate, ISolAccount};

    component!(path: SRC5Component, storage: src5, event: SRC5Event);
    component!(path: SRC9Component, storage: src9, event: SRC9Event);

    // SRC5 introspection: wallets / tooling discover what this contract implements
    // via supports_interface. The constructor registers ISRC6_ID (the entrypoints
    // above match the canonical SNIP-6 shape); ISRC5_ID itself needs no
    // registration — OZ's supports_interface answers it unconditionally.
    #[abi(embed_v0)]
    impl SRC5Impl = SRC5Component::SRC5Impl<ContractState>;
    // Not embedded: only the constructor needs register_interface.
    impl SRC5InternalImpl = SRC5Component::InternalImpl<ContractState>;

    // SNIP-9 outside execution: a relayer submits execute_from_outside_v2 with calls
    // the user pre-signed. Same garaga Ed25519 bundle, signed over the SNIP-12
    // outside-execution hash instead of a tx hash. OZ validates via a dispatcher
    // self-call into is_valid_signature above and asserts the result equals 'VALID'.
    // Because is_valid_signature is SNIP-6-conforming (it returns 0 for every rejection
    // it detects rather than reverting), a rejected sponsored signature surfaces as OZ's
    // generic 'SRC9: invalid signature', NOT the specific inner reason (e.g. 'MSG_NOT_BOUND'
    // or 'INVALID_SIG'). The specific reason is still the revert code on the direct
    // transaction-validation path (validate_tx), where the account panics with it.
    #[abi(embed_v0)]
    impl OutsideExecutionV2Impl =
        SRC9Component::OutsideExecutionV2Impl<ContractState>;
    // Not embedded: only the constructor needs initializer.
    impl SRC9InternalImpl = SRC9Component::InternalImpl<ContractState>;

    // SNIP-6 magic value returned by a valid signature / validation.
    const VALIDATED: felt252 = 'VALID';

    // sol_account on-chain class version, exposed as NON-GATING metadata. `upgrade` does
    // NOT gate on it (the identity() guard is the sole on-chain upgrade gate); it is kept
    // as a view (version()) and passed to the post-upgrade migration hook as
    // `from_version`. This is v1; numbering starts at 1.
    const VERSION: u32 = 1;

    // An Ed25519 public key is the 32-byte encoding of a curve point, read as a
    // little-endian u256: the low 255 bits are the point's y coordinate and bit
    // 255 is the sign of x. The encoding is canonical only when y is a field
    // element, i.e. y < p, where p = 2^255 - 19 is the Ed25519 field prime.
    // The constructor rejects the encodings garaga's verifier could never accept:
    // the zero key, a non-canonical encoding (y >= p), and any small-order (torsion)
    // point (see is_small_order_y). It does NOT prove on-curve membership; on-curve
    // rejection is enforced by garaga at signature-verification time, and the client
    // SDK applies the same non-zero and canonical checks before deriving an address,
    // so an off-curve key deploys but can never drive the account.
    const ED25519_FIELD_PRIME: u256 =
        0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed;
    // Selects the 255 y-coordinate bits, masking off bit 255 (the x sign bit).
    const ED25519_Y_MASK: u256 = 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff;

    // The canonical y-coordinates (x-sign bit stripped) of the complete Ed25519 torsion
    // subgroup, the eight points of order dividing the cofactor 8. garaga rejects a key
    // whose point is small order, so the constructor blocklists their y-coordinates. The
    // eight points collapse to five distinct y values: the two order-4 points share y = 0
    // (x = +/- sqrt(-1)); the identity is y = 1 (order 1); the order-2 point is y = p - 1;
    // and the four order-8 points collapse to two y values (a point and its negation share
    // y). Because a point and its negation share a y-coordinate, blocklisting the y value
    // rejects both x-sign encodings. This list was derived by enumerating the torsion group
    // with @noble/curves and confirmed against its isSmallOrder predicate.
    const SMALL_ORDER_Y_ZERO: u256 = 0x0;
    const SMALL_ORDER_Y_ONE: u256 = 0x1;
    const SMALL_ORDER_Y_ORDER8_A: u256 =
        0x5fc536d880238b13933c6d305acdfd5f098eff289f4c345b027b2c28f95e826;
    const SMALL_ORDER_Y_ORDER8_B: u256 =
        0x7a03ac9277fdc74ec6cc392cfa53202a0f67100d760b3cba4fd84d3d706a17c7;
    const SMALL_ORDER_Y_NEG_ONE: u256 =
        0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffec;

    // ─── Message binding (base64) ───
    // The owner signs a UTF-8 message whose FIXED TRAILING 44 bytes are the standard
    // base64 (alphabet A-Z a-z 0-9 + /, exactly one '=' pad) of the 32 big-endian bytes
    // of the operation hash (the tx hash for __validate*__, or the SNIP-12 outside-
    // execution hash for the sponsored path). An optional human-readable label may
    // PREFIX the hash, separated by a single '\n', so a wallet shows the user what they
    // approve. Binding decodes ONLY the last 44 bytes and compares u256-exact to the
    // hash - never a delimiter search: a label is dapp-controlled text and may itself
    // contain '\n' or base64-looking runs, so only the trailing window is authoritative
    // and a second hash embedded in the label is inert bytes. The label is ADVISORY:
    // Ed25519 covers every byte (nobody can alter a signed label), but the chain does
    // NOT check the label against the calls - honest display for honest dapps, zero
    // authority for dishonest ones (a malicious dapp can already choose the calls the
    // user blind-signs). Ed25519 malleability (s < L) is assumed enforced in garaga.
    const B64_HASH_LEN: u32 = 44;
    const MSG_SEPARATOR: u8 = 0x0a; // '\n'
    // 3-SHA-512-block ceiling: garaga hashes 64 + msg_len bytes plus >= 17 padding
    // bytes in 128-byte blocks, so 64 + 303 + 17 = 384 = 3 * 128 is the largest msg_len
    // that still fits 3 blocks. Also the DoS bound on attacker-chosen msg_len: it caps the
    // input length to garaga's per-byte SHA-512 hashing, the only msg_len-proportional
    // validation cost past deserialization (the Serde deserialize of the bundle also walks
    // every message byte, but protocol calldata limits already bound that; the base64
    // decode is fixed-width over the trailing 44 bytes, so its cost is constant). Label
    // budget = MAX_MSG_LEN - 44 - 1 = 258 bytes (see the README length/gas table).
    const MAX_MSG_LEN: u32 = 303;

    // Standard-base64 alphabet ASCII bounds + the pad char, for the decoder's
    // classifier (ranges in likelihood order: letters, digits, +, /).
    const B64_UPPER_A: u8 = 0x41; // 'A' -> 0
    const B64_UPPER_Z: u8 = 0x5a; // 'Z' -> 25
    const B64_LOWER_A: u8 = 0x61; // 'a' -> 26
    const B64_LOWER_Z: u8 = 0x7a; // 'z' -> 51
    const B64_DIGIT_0: u8 = 0x30; // '0' -> 52
    const B64_DIGIT_9: u8 = 0x39; // '9' -> 61
    const B64_PLUS: u8 = 0x2b; // '+' -> 62
    const B64_SLASH: u8 = 0x2f; // '/' -> 63
    const B64_PAD: u8 = 0x3d; // '='

    // Storage is name-addressed (see the storage-layout invariant on `upgrade`):
    // never rename, retype, or remove `public_key`, and never add a member (or
    // component substorage member) whose name collides with an existing one.
    // Declaration order is irrelevant.
    #[storage]
    struct Storage {
        public_key: u256,
        // Set true by `upgrade` ONLY for the span of its internal post-replace_class
        // self-call into `execute_after_upgrade`, and cleared immediately after. The
        // migration hook asserts it is true, so the hook is reachable ONLY from within
        // that self-call, on ANY route (multicall or SNIP-9 outside execution). Because
        // it lives in storage, a reverted upgrade tx rolls this back to false with the
        // rest of the state, so a failed migration can never leave it stuck true. Every
        // AnyStark replacement class MUST keep this member under the SAME name (name-addressed
        // storage shares the slot across replace_class) so its own `upgrade` set/clear
        // and hook guard interoperate with this one - see the mocks.
        migration_in_progress: bool,
        #[substorage(v0)]
        src5: SRC5Component::Storage,
        #[substorage(v0)]
        src9: SRC9Component::Storage,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        SignerInitialized: SignerInitialized,
        Upgraded: Upgraded,
        #[flat]
        SRC5Event: SRC5Component::Event,
        #[flat]
        SRC9Event: SRC9Component::Event,
    }

    // Emitted once, when the constructor sets the immutable Ed25519 signer.
    #[derive(Drop, starknet::Event)]
    struct SignerInitialized {
        public_key: u256,
    }

    // Emitted when the account replaces its own class (upgrade). Carries only the
    // NEW class hash. Note: this does not include the previous class hash, so a
    // monitor that missed an earlier Upgraded (or the original deploy) cannot
    // reconstruct the full from->to chain from a single event in isolation; the
    // prior class is recoverable from the preceding event / deploy or by reading
    // get_class_hash_at at the block before this one.
    #[derive(Drop, starknet::Event)]
    struct Upgraded {
        class_hash: ClassHash,
    }

    #[constructor]
    fn constructor(ref self: ContractState, public_key: u256) {
        // The account address is counterfactually derived from public_key, so a key
        // garaga's verifier could never accept permanently bricks an address that may
        // already hold funds (e.g. minted via CCTP), with no recovery. Fail fast at
        // deploy so a plainly-bad key reverts here instead of deploying a dead account.
        // The three checks below reject encodings garaga can never verify against:
        //   - non-zero: rejects the all-zero key (y = 0, x-sign 0);
        //   - canonical: y is a field element (y < p), so the encoding is unambiguous;
        //   - large-order: the point is outside the small-order (torsion) subgroup that
        //     garaga rejects (see is_small_order_y).
        // On-curve membership is NOT proven here; that check cost ~5.26M L2 gas per
        // deploy for a rejection garaga already enforces at signature-verification time,
        // and the client SDK applies the same non-zero and canonical checks before
        // deriving an address. So an off-curve key can deploy but can never drive the
        // account. The checks read only the y-coordinate (bit 255 is the x-sign,
        // irrelevant to order), so both x-sign encodings of a good key deploy.
        assert!(public_key != 0, "public_key must be non-zero");
        let y_coordinate = public_key & ED25519_Y_MASK;
        assert!(y_coordinate < ED25519_FIELD_PRIME, "public_key is not a canonical Ed25519 key");
        assert!(!is_small_order_y(y_coordinate), "public_key is a small-order point");
        self.public_key.write(public_key);
        self.emit(SignerInitialized { public_key });
        self.src5.register_interface(ISRC6_ID);
        // Registers ISRC9_V2_ID (via SRC5): outside execution is discoverable too.
        self.src9.initializer();
    }

    #[abi(embed_v0)]
    impl SolAccountImpl of ISolAccount<ContractState> {
        fn __validate__(self: @ContractState, calls: Array<Call>) -> felt252 {
            self.validate_tx()
        }

        fn __execute__(ref self: ContractState, calls: Array<Call>) -> Array<Span<felt252>> {
            // Only the protocol (caller 0) may drive execution.
            assert(get_caller_address().is_zero(), 'INVALID_CALLER');
            let self_addr = get_contract_address();
            let mut res = array![];
            for call in calls.span() {
                let Call { to, selector, calldata } = *call;
                // FORBIDDEN-CALL guard (Argent's forbidden-call pattern), kept as
                // fail-fast DEFENSE-IN-DEPTH and SCOPED to SELF-CALLS (to == this
                // account): the migration hook execute_after_upgrade is reachable ONLY as
                // `upgrade`'s internal post-replace_class self-call, and that invariant is
                // enforced path-independently at the CALLEE by the `migration_in_progress`
                // storage flag (the hook asserts it, `upgrade` sets/clears it). This guard
                // rejects the forbidden selector early on the self-execute multicall path
                // so a user-signed multicall never even reaches the hook. Because only a
                // self-call can reach THIS account's hook, the guard is scoped to
                // self-targets: the account stays free to invoke a function that merely
                // SHARES the name execute_after_upgrade on an unrelated external contract.
                // It is NOT the sole protection: the SNIP-9 SRC9 component executes its
                // own calls via a raw call_contract_syscall that bypasses this entrypoint,
                // so ONLY the callee flag closes that route - see execute_after_upgrade's
                // NOT_IN_MIGRATION assert.
                if to == self_addr {
                    assert(selector != selector!("execute_after_upgrade"), 'FORBIDDEN_CALL');
                }
                res.append(call_contract_syscall(to, selector, calldata).unwrap_syscall());
            }
            res
        }

        fn is_valid_signature(
            self: @ContractState, hash: felt252, signature: Array<felt252>,
        ) -> felt252 {
            // SNIP-6 conformance: a valid signature returns the 'VALID' magic value, and
            // EVERY rejection this contract detects returns 0 (never a revert), matching how
            // OZ accounts answer. The non-panicking core (validate_signature) runs the whole
            // check and reports the reason as Result::Err, mapped to 0 here. HONEST LIMIT:
            // garaga's verifier can still panic INTERNALLY when a bundle's MSM / sqrt hints
            // are self-inconsistent (a hint-tampered bundle), and that panic cannot be caught
            // on-chain; so this is non-reverting for every rejection the contract itself
            // detects, while a hint-tampered bundle still reverts inside garaga. The
            // transaction-validation path (validate_tx) instead panics with the named reason,
            // so tx-rejection codes are unchanged.
            match self.validate_signature(hash, signature.span()) {
                Result::Ok(magic) => magic,
                Result::Err(_) => 0,
            }
        }

        fn get_public_key(self: @ContractState) -> u256 {
            self.public_key.read()
        }
    }

    #[abi(embed_v0)]
    impl DeployValidateImpl of IDeployValidate<ContractState> {
        fn __validate_deploy__(
            self: @ContractState, class_hash: felt252, salt: felt252, public_key: u256,
        ) -> felt252 {
            // The DeployAccount tx is signed over its tx hash, same as any invoke.
            // DEPLOY_ACCOUNT ordering: the constructor runs FIRST and initializes
            // public_key, then __validate_deploy__ validates the signed tx hash against
            // that stored key, which is why reading storage here is correct. The
            // `public_key` argument is the constructor-calldata echo and is already
            // covered by the signed tx hash, so it needs no separate check.
            self.validate_tx()
        }

        fn __validate_declare__(self: @ContractState, class_hash: felt252) -> felt252 {
            self.validate_tx()
        }
    }

    #[abi(embed_v0)]
    impl VersionedUpgradeImpl of super::IVersionedUpgrade<ContractState> {
        fn version(self: @ContractState) -> u32 {
            VERSION
        }

        // Identity guard: see SOL_ACCOUNT_IDENTITY docs.
        fn identity(self: @ContractState) -> felt252 {
            super::SOL_ACCOUNT_IDENTITY
        }

        fn execute_after_upgrade(ref self: ContractState, from_version: u32) {
            // Reachable ONLY from within `upgrade`'s internal post-replace_class
            // self-call. Two asserts make that TRUE on every route:
            //   - caller == self: the account calls itself during the hook self-call.
            //   - migration_in_progress: `upgrade` sets this flag true for exactly the
            //     span of that self-call and clears it after, so ANY standalone call sees
            //     it false and reverts NOT_IN_MIGRATION. This is what closes the SNIP-9
            //     gap: OZ's SRC9 runs outside-execution calls via a raw
            //     call_contract_syscall that bypasses __execute__'s FORBIDDEN_CALL guard,
            //     and there caller == self is also satisfied (the account is executing its
            //     own pre-signed calls), so the caller check alone is not enough. The flag
            //     is path-independent, so a forbidden call from any route is caught here.
            //     Storage reverts with the tx, so a reverted upgrade rolls the flag back
            //     to false and can never leave it stuck.
            //
            // FORWARD CONSTRAINT (fund-critical for future versions): `from_version` is
            // NOT trustworthy. Although `upgrade` passes the real old VERSION on the
            // happy path, this is a PUBLIC entrypoint the owner can self-call standalone
            // with ANY value (caller == self is the only gate). So this v1 body
            // deliberately IGNORES `from_version` and stays fully idempotent - it only
            // re-registers SRC5 ids, which is safe to replay any number of times. ANY
            // future version's hook MUST likewise treat `from_version` as untrusted and
            // remain idempotent / replay-safe: never use it to gate a one-time state
            // transition (a re-invocation with a forged `from_version` would replay or
            // skip that transition). v1 has no prior version to migrate from, so it just
            // re-establishes the constructor's SRC5 registrations below.
            assert(get_caller_address() == get_contract_address(), 'NOT_SELF');
            assert(self.migration_in_progress.read(), 'NOT_IN_MIGRATION');
            let _ = from_version;
            // Idempotently re-register the SRC5 interface ids the constructor sets.
            // replace_class does NOT re-run the constructor, so an account upgrading
            // INTO this class would otherwise keep the SRC9 entrypoints live but lose
            // SRC5 discoverability. register_interface only writes `true`, so
            // re-running here is safe (and harmless on a freshly-deployed v1). This
            // closes the README's SRC5-discovery caveat for the guarded upgrade path.
            self.src5.register_interface(ISRC6_ID);
            self.src9.initializer();
        }
    }

    #[abi(embed_v0)]
    impl UpgradeableImpl of super::IUpgradeable<ContractState> {
        // STORAGE-LAYOUT INVARIANT (fund-critical): replace_class preserves the
        // storage tree, so every replacement class MUST keep the `public_key: u256`
        // signer at the exact same storage slot (storage should be append-only:
        // never reorder, retype, or remove `public_key`). That signer is what
        // counterfactually derives the user's address; if a V2 changes its slot the
        // account would re-interpret or orphan its root signer after upgrade. This
        // is a layout contract V2 authors must honor; it cannot be enforced on-chain
        // here. See the `upgrade_preserves_signer_slot` regression test.
        //
        // TRUST MODEL: `upgrade` is OWNER-AUTHORIZED - the caller == self check means
        // the only route here is the Ed25519 owner driving a signed __execute__ that
        // calls back into this account.
        //
        // The on-chain anti-brick protections are exactly two, and both are honest
        // about what they can prove:
        //   (a) SOL_ACCOUNT IDENTITY - the identity() library-call guard below. identity()
        //       is a pure const, so the library call reads the TARGET class's self-reported
        //       identity (not this account's storage); a target whose identity() !=
        //       SOL_ACCOUNT_IDENTITY (or that lacks identity()) reverts the upgrade
        //       ('NOT_SOL_ACCOUNT'), so only sol_account classes are accepted. This is a
        //       MISTAKE guard (wrong-project hash, typo, undeclared class), NOT a security
        //       boundary: a malicious class that LIES in identity() is not stopped, so the
        //       owner MUST validate targets off-chain (upgrade is manual and user-chosen).
        //   (b) A REQUIRED MIGRATION HOOK - the post-replace self-call into
        //       execute_after_upgrade (below). A target lacking identity() OR
        //       execute_after_upgrade reverts the whole upgrade (the account stays on
        //       the current class); see the atomicity tests.
        // Downgrade / same-version protection is DELIBERATELY dropped: `upgrade` accepts
        // ANY identity-compliant class, including an OLDER one or the SAME class (a no-op
        // re-install). A future versioned scheme can only start from a future class forward;
        // version() is retained as non-gating metadata, not as an upgrade gate.
        // INVARIANT (release discipline, fund-critical): every sol_account class MUST
        // retain a working `upgrade()` and self-report SOL_ACCOUNT_IDENTITY, so the fleet
        // can always move forward. A release-time test (upgrade_target_is_itself_upgradeable)
        // enforces that any next class stays an upgradeable sol_account target end to end.
        // What is DELIBERATELY NOT attempted: verifying on-chain that the target class
        // has a working __validate__ / __execute__ (i.e. that it "is an account"). That
        // cannot be done before the swap - a storage-backed supports_interface library
        // call would run against THIS account's storage and answer for the CURRENT
        // class, not the target, so it proves nothing about the target. The owner MUST
        // therefore declare and dry-run-validate any new class off-chain before
        // upgrading (see README).
        //
        // The guard is ANTI-FOOTGUN, not anti-owner: it runs a library call against the
        // owner-supplied `new_class_hash` BEFORE replace_class, catching an HONEST target
        // that self-reports the wrong identity() (wrong-project hash, typo, undeclared
        // class). It is NOT a security boundary: library_call_syscall runs the target's
        // code in THIS account's storage context with no sandbox, so a malicious target's
        // identity() can freely mutate this account's state or act as the account while it
        // runs. A wrong-identity return reverts the tx and rolls back any such mutation, but
        // a target that lies (returns SOL_ACCOUNT_IDENTITY) and mutates is not stopped. The
        // residual risk is therefore the owner supplying a hostile or broken class at all:
        // the owner MUST fully vet `new_class_hash` off-chain (declare and dry-run-validate
        // it), which is the only thing that catches a lying target or a class that clears
        // the guard but is not a working account.
        fn upgrade(ref self: ContractState, new_class_hash: ClassHash) {
            let this = get_contract_address();
            assert(get_caller_address() == this, 'NOT_SELF');
            assert(new_class_hash.is_non_zero(), 'ZERO_CLASS');

            // Identity guard: see SOL_ACCOUNT_IDENTITY docs.
            let mut identity_return = library_call_syscall(
                new_class_hash, selector!("identity"), array![].span(),
            )
                .unwrap_syscall();
            let target_identity: felt252 = Serde::deserialize(ref identity_return)
                .expect('BAD_IDENTITY_RET');
            assert(target_identity == super::SOL_ACCOUNT_IDENTITY, 'NOT_SOL_ACCOUNT');

            replace_class_syscall(new_class_hash).unwrap_syscall();
            self.emit(Upgraded { class_hash: new_class_hash });

            // Migration hook: post-replace, a contract call to self routes to the NEW
            // class (replace_class takes effect for subsequent calls within the same
            // tx, exactly as OZ's upgrade_and_call relies on). Pass this (old) class's
            // VERSION as from_version so the new class can run version-specific
            // migrations. A dispatcher/self-call is used (not a library call into
            // new_class_hash) so the hook executes as a genuine post-swap call - the
            // same in-tx replace semantics the upgrade tests already exercise.
            //
            // Open the migration window ONLY around this self-call: the flag lets the
            // hook (which is also a public, caller==self-gated entrypoint) tell a genuine
            // upgrade-driven invocation apart from a standalone one on any route
            // (multicall or SNIP-9). It is set true immediately before the call and
            // cleared immediately after; if the hook (or anything after) reverts, storage
            // rolls back with the tx and the flag returns to false, so it can never stick.
            self.migration_in_progress.write(true);
            call_contract_syscall(
                this, selector!("execute_after_upgrade"), array![VERSION.into()].span(),
            )
                .unwrap_syscall();
            self.migration_in_progress.write(false);
        }
    }

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        /// Validate the current transaction by its hash against the stored signer. Panics
        /// with the named reason on any rejection, so __validate__ / __validate_deploy__ /
        /// __validate_declare__ keep their EXACT named tx-rejection errors (the reason is
        /// the revert code the protocol sees).
        fn validate_tx(self: @ContractState) -> felt252 {
            let tx_info = get_tx_info().unbox();
            match self.validate_signature(tx_info.transaction_hash, tx_info.signature) {
                Result::Ok(magic) => magic,
                Result::Err(reason) => core::panic_with_felt252(reason),
            }
        }

        /// Non-panicking validation core. Returns Ok('VALID') iff `signature` is a
        /// well-formed garaga EdDSA bundle whose signed message is bound to `hash` AND whose
        /// Ed25519 signature verifies against THIS account's stored signer; otherwise
        /// Err(named reason). Validation is two steps: message binding, then Ed25519
        /// verification (garaga). garaga verifies against the stored key passed as
        /// Py_twisted, so signer binding is structural (a foreign signer yields
        /// Err('INVALID_SIG')), not a separate calldata comparison. Every rejection this
        /// contract detects is a DESCRIPTIVE Err, never an unchecked index, underflow, or
        /// unwrap; the two callers choose the surface (is_valid_signature maps Err to 0 for
        /// SNIP-6 conformance, validate_tx panics with the reason). HONEST LIMIT: garaga's
        /// verifier can still panic internally on a bundle whose MSM / sqrt hints are
        /// self-inconsistent, which no on-chain code can catch.
        fn validate_signature(
            self: @ContractState, hash: felt252, signature: Span<felt252>,
        ) -> Result<felt252, felt252> {
            // Deserialize the garaga bundle first. garaga v1's EdDSASignature exposes
            // `pub` fields, so the signed message is read as a typed Span<u8> straight
            // off the decoded struct - no hand-rolled felt offsets. Serde returns None on
            // ANY malformed encoding (a short span, a msg_len that is not a u32, or a msg
            // felt that is not a byte), reported as the NAMED 'BAD_SIG_ENCODING'. This keeps
            // the core panic-free on hostile input: every rejection below is a descriptive
            // Err, never an unchecked index, underflow, or unwrap.
            let mut span = signature;
            let bundle = match Serde::<EdDSASignatureWithHint>::deserialize(ref span) {
                Option::Some(bundle) => bundle,
                Option::None => { return Result::Err('BAD_SIG_ENCODING'); },
            };
            // The bundle owns the whole signature span: trailing felts past the decoded
            // struct are rejected so each valid signature has exactly one canonical
            // encoding (no malleable padding for relayed calldata or indexers).
            if span.len() != 0 {
                return Result::Err('SIG_HAS_EXTRA_DATA');
            }

            // Bind the signed message to `hash` (replay / calldata protection). The
            // owner signs UTF-8 text whose FIXED TRAILING 44 bytes are standard base64
            // of the 32 big-endian bytes of `hash`, optionally prefixed by a readable
            // label + '\n' (see the module-level binding notes). We decode ONLY those
            // last 44 bytes and compare u256-exact. Every message byte is transitively
            // attested by the signature: garaga (below) hashes the exact msg bytes, so
            // altering any of them changes the SHA-512 input and yields Err('INVALID_SIG').
            let msg: Span<u8> = bundle.signature.msg;
            let msg_len: u32 = msg.len();
            // Bound the attacker-chosen length before garaga runs; see MAX_MSG_LEN for the
            // cost analysis.
            if msg_len < B64_HASH_LEN {
                return Result::Err('MSG_TOO_SHORT');
            }
            if msg_len > MAX_MSG_LEN {
                return Result::Err('MSG_TOO_LONG');
            }

            // Fixed trailing window: the 44 base64 bytes are always the message's tail.
            // msg_len >= B64_HASH_LEN is checked immediately above, so the offset is
            // already safe; saturating_sub is belt-and-suspenders per the defensive-
            // arithmetic convention, so a future refactor that weakens the guard still
            // cannot underflow here (it would clamp to 0, not wrap).
            let b64_start = msg_len.saturating_sub(B64_HASH_LEN);

            // With a label present (msg_len > 44) the byte immediately before the base64
            // tail MUST be the '\n' separator: it isolates the hash on its own wallet-popup
            // line and rejects encoders that glue label text onto the hash. (msg_len == 45
            // is an empty label + separator: allowed, but the SDK never emits it.)
            if msg_len > B64_HASH_LEN && *msg.at(b64_start - 1) != MSG_SEPARATOR {
                return Result::Err('BAD_MSG_SEPARATOR');
            }

            // Canonical base64-decode the trailing 44 bytes to a u256 and compare
            // INTEGER-EXACT so a hash congruent to `hash` mod the Stark prime cannot alias
            // (an integer u256 compare, not a mod-p felt accumulation). decode_b64_hash is
            // itself non-panicking; `?` forwards its named b64 Err ('BAD_B64_CHAR' /
            // 'BAD_B64_PAD') unchanged.
            let decoded = decode_b64_hash(msg, b64_start)?;
            if decoded != hash.into() {
                return Result::Err('MSG_NOT_BOUND');
            }

            // Verify the Ed25519 signature over those bytes (garaga), against THIS
            // account's stored signer passed as Py_twisted. A bundle carrying any other
            // key yields Err('INVALID_SIG'): signer binding is structural, not a
            // calldata comparison. garaga v1 additionally rejects RFC 8032 small-order
            // points ([8]P != O) for both the signature point R and the public key.
            if !is_valid_eddsa_signature(bundle, self.public_key.read()) {
                return Result::Err('INVALID_SIG');
            }
            Result::Ok(VALIDATED)
        }
    }

    /// True iff `y` (a canonical Ed25519 y-coordinate, y < p) is the y-coordinate of a
    /// small-order (torsion) point, which garaga rejects. The complete torsion subgroup
    /// collapses to five distinct y values; see the SMALL_ORDER_Y_* constants for the
    /// derivation. Both x-sign encodings of a torsion point share its y-coordinate, so
    /// matching on y rejects both.
    fn is_small_order_y(y: u256) -> bool {
        y == SMALL_ORDER_Y_ZERO
            || y == SMALL_ORDER_Y_ONE
            || y == SMALL_ORDER_Y_ORDER8_A
            || y == SMALL_ORDER_Y_ORDER8_B
            || y == SMALL_ORDER_Y_NEG_ONE
    }

    /// Decode the standard-base64 (exactly one '=' pad) at [start, start + 44) into the
    /// 32 big-endian bytes it encodes, folded into a u256 (bytes 0..15 -> high, 16..31 ->
    /// low, matching a felt's u256 promotion). Returns Err with a named request-safe reason
    /// on a non-alphabet char ('BAD_B64_CHAR'), a missing '=' pad, or non-zero pad bits
    /// ('BAD_B64_PAD') - non-panicking by construction on any attacker-controlled input, so
    /// the validation core stays panic-free. The caller guarantees msg carries
    /// [start, start + 44): msg_len >= 44 (MSG_TOO_SHORT) and start = msg_len - 44, so no
    /// index here is OOB.
    fn decode_b64_hash(msg: Span<u8>, start: u32) -> Result<u256, felt252> {
        // 10 full 4-char groups -> 30 bytes; the final padded group -> 2 bytes = 32.
        // Each decoded byte is folded into the u256 accumulators AS it is produced (single
        // pass), big-endian and in strictly ascending byte position: bytes 0..15 -> high,
        // 16..31 -> low (each 128 bits, so the felt accumulators never overflow). Every
        // byte's position is known statically from its group, and bytes are produced in
        // ascending position order, so this interleaved single-pass fold produces the same
        // u256 as buffering the bytes first and folding in a second pass. Each accumulator
        // folds exactly 16 bytes (128 bits), so the final felt -> u128 narrowing fits by
        // construction; the 'B64_ACC_OVERFLOW' Err below names that invariant instead of
        // a raw unwrap, keeping every rejection a descriptive named error.
        let mut acc_high: felt252 = 0;
        let mut acc_low: felt252 = 0;

        let mut group: u32 = 0;
        while group < 10 {
            let group_start = start + group * 4;
            let sextet0 = b64_sextet(read_msg_byte(msg, group_start))?;
            let sextet1 = b64_sextet(read_msg_byte(msg, group_start + 1))?;
            let sextet2 = b64_sextet(read_msg_byte(msg, group_start + 2))?;
            let sextet3 = b64_sextet(read_msg_byte(msg, group_start + 3))?;
            // 24-bit group value (< 2^24, fits u32): v0<<18 | v1<<12 | v2<<6 | v3.
            let group_value = sextet0 * 0x40000 + sextet1 * 0x1000 + sextet2 * 0x40 + sextet3;
            // This group decodes to bytes at positions [group*3, group*3 + 3); group 5
            // straddles the high/low boundary (positions 15, 16, 17), which fold_byte
            // handles per byte via its own position test.
            let byte_position = group * 3;
            fold_byte(ref acc_high, ref acc_low, byte_position, (group_value / 0x10000).into());
            fold_byte(
                ref acc_high, ref acc_low, byte_position + 1, ((group_value / 0x100) % 0x100).into(),
            );
            fold_byte(ref acc_high, ref acc_low, byte_position + 2, (group_value % 0x100).into());
            group += 1;
        }

        // Final group (chars 40..43): char 43 is the single '=' pad, and char 42 carries
        // only 4 significant bits, so its low 2 bits MUST be zero. Together these make
        // each 32-byte value have exactly ONE accepted 44-char encoding (canonicality).
        let final_start = start + 40;
        if read_msg_byte(msg, final_start + 3) != B64_PAD {
            return Result::Err('BAD_B64_PAD');
        }
        let sextet40 = b64_sextet(read_msg_byte(msg, final_start))?;
        let sextet41 = b64_sextet(read_msg_byte(msg, final_start + 1))?;
        let sextet42 = b64_sextet(read_msg_byte(msg, final_start + 2))?;
        if sextet42 % 0x4 != 0 { // low 2 pad bits zero
            return Result::Err('BAD_B64_PAD');
        }
        // The final two bytes sit at positions 30 and 31 (both in the low half).
        fold_byte(ref acc_high, ref acc_low, 30, (sextet40 * 0x4 + sextet41 / 0x10).into());
        fold_byte(ref acc_high, ref acc_low, 31, ((sextet41 % 0x10) * 0x10 + sextet42 / 0x4).into());

        let low: u128 = match acc_low.try_into() {
            Option::Some(value) => value,
            Option::None => { return Result::Err('B64_ACC_OVERFLOW'); },
        };
        let high: u128 = match acc_high.try_into() {
            Option::Some(value) => value,
            Option::None => { return Result::Err('B64_ACC_OVERFLOW'); },
        };
        Result::Ok(u256 { low, high })
    }

    /// Fold one big-endian byte into the u256 accumulators by its position: bytes 0..15
    /// build the high 128 bits, 16..31 the low.
    fn fold_byte(ref acc_high: felt252, ref acc_low: felt252, position: u32, byte_value: felt252) {
        if position < 16 {
            acc_high = acc_high * 0x100 + byte_value;
        } else {
            acc_low = acc_low * 0x100 + byte_value;
        }
    }

    /// One message byte from the decoded Span<u8>. Serde already narrowed every msg
    /// felt to a u8 during bundle decode (a non-byte fails 'BAD_SIG_ENCODING' there), so
    /// this is a direct indexed read; the caller's window guarantees it is in bounds.
    fn read_msg_byte(msg: Span<u8>, index: u32) -> u8 {
        *msg.at(index)
    }

    /// Standard-base64 char -> its 0..63 six-bit value; any other byte yields
    /// Err('BAD_B64_CHAR'). Ranges are checked in rough likelihood order.
    fn b64_sextet(b64_char: u8) -> Result<u32, felt252> {
        if b64_char >= B64_UPPER_A && b64_char <= B64_UPPER_Z {
            Result::Ok((b64_char - B64_UPPER_A).into())
        } else if b64_char >= B64_LOWER_A && b64_char <= B64_LOWER_Z {
            Result::Ok((b64_char - B64_LOWER_A + 26).into())
        } else if b64_char >= B64_DIGIT_0 && b64_char <= B64_DIGIT_9 {
            Result::Ok((b64_char - B64_DIGIT_0 + 52).into())
        } else if b64_char == B64_PLUS {
            Result::Ok(62)
        } else if b64_char == B64_SLASH {
            Result::Ok(63)
        } else {
            Result::Err('BAD_B64_CHAR')
        }
    }
}
