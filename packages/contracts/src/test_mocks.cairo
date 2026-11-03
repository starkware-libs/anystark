// Test-only mocks. Never compiled into production artifacts (gated by
// `#[cfg(test)] mod test_mocks;` in lib.cairo).

// The call target of the locked SNIP-9 vector (test_outside_execution.cairo):
// records the last `transfer` call so a test can prove execute_from_outside_v2
// really executed the signed call — and that the target observed the ACCOUNT as
// its caller (the outside relayer never appears in the call chain).
#[starknet::interface]
pub trait ICallReceiver<TState> {
    fn transfer(ref self: TState, value: felt252);
    fn last_call(self: @TState) -> (starknet::ContractAddress, felt252);
}

#[starknet::contract]
pub mod CallReceiverMock {
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{ContractAddress, get_caller_address};
    use super::ICallReceiver;

    #[storage]
    struct Storage {
        last_caller: ContractAddress,
        last_value: felt252,
    }

    #[abi(embed_v0)]
    impl Impl of ICallReceiver<ContractState> {
        fn transfer(ref self: ContractState, value: felt252) {
            self.last_caller.write(get_caller_address());
            self.last_value.write(value);
        }

        fn last_call(self: @ContractState) -> (ContractAddress, felt252) {
            (self.last_caller.read(), self.last_value.read())
        }
    }
}

// An UNRELATED external contract that merely exposes an entrypoint named
// execute_after_upgrade. It records the `from_version` it was last called with so a test
// can prove a normal __execute__ multicall reached this foreign target: __execute__'s
// FORBIDDEN_CALL guard is scoped to self-calls (to == the account), so the account can
// still invoke a function that shares the migration hook's name on a contract that is not
// itself.
#[starknet::interface]
pub trait IExternalMigrationHook<TState> {
    fn execute_after_upgrade(ref self: TState, from_version: u32);
    fn last_from_version(self: @TState) -> u32;
}

#[starknet::contract]
pub mod ExternalMigrationHookMock {
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use super::IExternalMigrationHook;

    #[storage]
    struct Storage {
        recorded_from_version: u32,
    }

    #[abi(embed_v0)]
    impl Impl of IExternalMigrationHook<ContractState> {
        fn execute_after_upgrade(ref self: ContractState, from_version: u32) {
            self.recorded_from_version.write(from_version);
        }

        fn last_from_version(self: @ContractState) -> u32 {
            self.recorded_from_version.read()
        }
    }
}

// A guard-COMPLIANT V2 upgrade target: self-reports the sol_account identity
// (identity), exposes a version() view (== 2), and keeps `public_key: u256` as its
// FIRST storage field (so replace_class preserves the root signer). It also proves the
// migration hook ran: `execute_after_upgrade` (self-only) records the `from_version` it
// was called with, which a test reads back. `is_valid_signature` accepts everything, so
// a test that upgrades into it can also observe the class swap via a previously-rejected
// signature now returning 'VALID'.
#[starknet::interface]
pub trait ICompliantV2<TState> {
    fn version(self: @TState) -> u32;
    // Self-reported sol_account identity: SolAccount's `upgrade` guard library-calls this
    // on the TARGET class and requires it to equal SOL_ACCOUNT_IDENTITY, so a compliant
    // target must report the same const to be accepted (the guard is identity + hook).
    fn identity(self: @TState) -> felt252;
    fn get_public_key(self: @TState) -> u256;
    fn is_valid_signature(self: @TState, hash: felt252, signature: Array<felt252>) -> felt252;
    fn execute_after_upgrade(ref self: TState, from_version: u32);
    fn migration_ran(self: @TState) -> bool;
    fn migrated_from(self: @TState) -> u32;
}

#[starknet::contract]
pub mod CompliantV2Account {
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::syscalls::{call_contract_syscall, library_call_syscall, replace_class_syscall};
    use starknet::{ClassHash, SyscallResultTrait, get_caller_address, get_contract_address};
    use crate::{IUpgradeable, SOL_ACCOUNT_IDENTITY};
    use super::ICompliantV2;

    const VERSION: u32 = 2;

    // `public_key` MUST stay the first field, byte-for-byte the same slot layout as
    // SolAccount::Storage, so replace_class preserves the root signer. `migration_in_progress`
    // shares SolAccount's flag slot (name-addressed storage) so the migration-window
    // handshake survives replace_class: SolAccount's `upgrade` sets it true before the
    // post-swap self-call into THIS class's execute_after_upgrade, and this mock's OWN
    // `upgrade` does the same when driving a further upgrade into a compliant v3.
    #[storage]
    struct Storage {
        public_key: u256,
        migration_in_progress: bool,
        migration_ran: bool,
        migrated_from: u32,
    }

    // A genuinely upgradeable sol_account target: this mock keeps a WORKING guarded
    // `upgrade()` mirroring SolAccount's (identity guard + migration-hook self-call), so
    // the release-time invariant test can upgrade v1 -> this (v2) -> a compliant v3 and
    // prove the fleet can always keep moving forward (see
    // upgrade_target_is_itself_upgradeable).
    #[abi(embed_v0)]
    impl UpgradeImpl of IUpgradeable<ContractState> {
        fn upgrade(ref self: ContractState, new_class_hash: ClassHash) {
            assert(get_caller_address() == get_contract_address(), 'NOT_SELF');
            let mut identity_return = library_call_syscall(
                new_class_hash, selector!("identity"), array![].span(),
            )
                .unwrap_syscall();
            let target_identity: felt252 = Serde::deserialize(ref identity_return).unwrap();
            assert(target_identity == SOL_ACCOUNT_IDENTITY, 'NOT_SOL_ACCOUNT');
            replace_class_syscall(new_class_hash).unwrap_syscall();
            // Mirror SolAccount's migration-window handshake: open the flag around the
            // post-replace self-call so the target's hook accepts this upgrade-driven
            // invocation, then clear it.
            self.migration_in_progress.write(true);
            call_contract_syscall(
                get_contract_address(),
                selector!("execute_after_upgrade"),
                array![VERSION.into()].span(),
            )
                .unwrap_syscall();
            self.migration_in_progress.write(false);
        }
    }

    #[abi(embed_v0)]
    impl Impl of ICompliantV2<ContractState> {
        fn version(self: @ContractState) -> u32 {
            VERSION
        }

        fn identity(self: @ContractState) -> felt252 {
            SOL_ACCOUNT_IDENTITY
        }

        fn get_public_key(self: @ContractState) -> u256 {
            self.public_key.read()
        }

        fn is_valid_signature(
            self: @ContractState, hash: felt252, signature: Array<felt252>,
        ) -> felt252 {
            'VALID'
        }

        // Self-only migration hook, mirroring SolAccount's own: gated by both caller ==
        // self AND the shared migration_in_progress flag, so it is reachable only from
        // within an upgrade's post-replace self-call. Records that it ran and the version
        // it was upgraded from, so a test can assert a concrete effect.
        fn execute_after_upgrade(ref self: ContractState, from_version: u32) {
            assert(get_caller_address() == get_contract_address(), 'NOT_SELF');
            assert(self.migration_in_progress.read(), 'NOT_IN_MIGRATION');
            self.migration_ran.write(true);
            self.migrated_from.write(from_version);
        }

        fn migration_ran(self: @ContractState) -> bool {
            self.migration_ran.read()
        }

        fn migrated_from(self: @ContractState) -> u32 {
            self.migrated_from.read()
        }
    }
}

// Shared minimal interfaces for the guard-NEGATIVE upgrade targets below. Each mock
// embeds only the entrypoints its scenario needs, so a library call into it either
// answers with the wrong value (rejected by an assert) or fails outright (missing
// entrypoint).
#[starknet::interface]
pub trait IHasMigrationHook<TState> {
    fn execute_after_upgrade(ref self: TState, from_version: u32);
}

// sol_account identity entrypoint, so a mock can clear (or deliberately mis-report) the
// `upgrade` identity guard (identity() == SOL_ACCOUNT_IDENTITY) and reach the scenario
// it pins.
#[starknet::interface]
pub trait IHasIdentity<TState> {
    fn identity(self: @TState) -> felt252;
}

// Self-reports the sol_account identity so it clears the identity guard, but its
// migration hook always PANICS. Used to pin the fund-safety atomicity invariant:
// `upgrade` replaces the class and then self-calls execute_after_upgrade, so a panicking
// hook makes that self-call re-panic and Starknet rolls the replace_class back - the
// account stays on the current class, never half-upgraded.
#[starknet::contract]
pub mod MigrationPanicAccount {
    use crate::SOL_ACCOUNT_IDENTITY;
    use super::{IHasIdentity, IHasMigrationHook};

    #[storage]
    struct Storage {
        public_key: u256,
    }

    // Clears the identity guard so the upgrade reaches the migration hook, which is
    // where this mock forces the atomicity failure.
    #[abi(embed_v0)]
    impl IdentityImpl of IHasIdentity<ContractState> {
        fn identity(self: @ContractState) -> felt252 {
            SOL_ACCOUNT_IDENTITY
        }
    }

    #[abi(embed_v0)]
    impl HookImpl of IHasMigrationHook<ContractState> {
        fn execute_after_upgrade(ref self: ContractState, from_version: u32) {
            let _ = from_version;
            core::panic_with_felt252('MIGRATION_BOOM');
        }
    }
}

// Clears the identity guard but has NO execute_after_upgrade entrypoint. The ABSENT-hook
// variant of the atomicity invariant: `upgrade`'s post-replace self-call to
// execute_after_upgrade fails (entrypoint not found), reverting the replace_class, so
// the account stays on the current class.
#[starknet::contract]
pub mod NoMigrationHookAccount {
    use crate::SOL_ACCOUNT_IDENTITY;
    use super::IHasIdentity;

    #[storage]
    struct Storage {
        public_key: u256,
    }

    // Clears the identity guard so the upgrade reaches the post-replace hook self-call,
    // which fails here because there is NO execute_after_upgrade entrypoint (the
    // absent-hook atomicity path).
    #[abi(embed_v0)]
    impl IdentityImpl of IHasIdentity<ContractState> {
        fn identity(self: @ContractState) -> felt252 {
            SOL_ACCOUNT_IDENTITY
        }
    }
}

// A pre-SNIP-9 account: it has the signer slot and a self-authorized (BARE) `upgrade`,
// but registers NO SRC5 interfaces and runs no migration hook. Upgrading it to
// SolAccount's class proves the LEGACY discovery caveat still holds - the SRC9
// entrypoints go live but supports_interface stays blind, because this old class's
// bare upgrade neither re-registers nor invokes execute_after_upgrade (the guarded
// upgrade path that would close the caveat lives in SolAccount, not here).
#[starknet::contract]
pub mod OldNoSrc5Account {
    use starknet::storage::StoragePointerWriteAccess;
    use starknet::syscalls::replace_class_syscall;
    use starknet::{ClassHash, SyscallResultTrait, get_caller_address, get_contract_address};
    use crate::IUpgradeable;

    #[storage]
    struct Storage {
        public_key: u256,
    }

    #[constructor]
    fn constructor(ref self: ContractState, public_key: u256) {
        self.public_key.write(public_key);
    }

    #[abi(embed_v0)]
    impl Impl of IUpgradeable<ContractState> {
        fn upgrade(ref self: ContractState, new_class_hash: ClassHash) {
            assert(get_caller_address() == get_contract_address(), 'NOT_SELF');
            replace_class_syscall(new_class_hash).unwrap_syscall();
        }
    }
}

// A compliant V3 target (version 3, sol_account identity, migration hook, faithful signer
// slot): the terminal class in the release-time invariant test, which upgrades v1 -> V2 ->
// V3 to prove a compliant target ITSELF retains a working upgrade so the fleet keeps
// moving. Reuses the ICompliantV2 surface (version() just returns 3) so tests read it back
// with the same dispatcher.
#[starknet::contract]
pub mod CompliantV3Account {
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{get_caller_address, get_contract_address};
    use crate::SOL_ACCOUNT_IDENTITY;
    use super::ICompliantV2;

    // `migration_in_progress` shares the flag slot (name-addressed) that the UPGRADING
    // class (v2) sets true before the post-replace self-call into this class's hook, so
    // this terminal class's execute_after_upgrade sees the open window. This mock is a
    // dead end (no `upgrade`), so it only READS the flag; it never sets one.
    #[storage]
    struct Storage {
        public_key: u256,
        migration_in_progress: bool,
        migration_ran: bool,
        migrated_from: u32,
    }

    #[abi(embed_v0)]
    impl Impl of ICompliantV2<ContractState> {
        fn version(self: @ContractState) -> u32 {
            3
        }

        fn identity(self: @ContractState) -> felt252 {
            SOL_ACCOUNT_IDENTITY
        }

        fn get_public_key(self: @ContractState) -> u256 {
            self.public_key.read()
        }

        fn is_valid_signature(
            self: @ContractState, hash: felt252, signature: Array<felt252>,
        ) -> felt252 {
            'VALID'
        }

        fn execute_after_upgrade(ref self: ContractState, from_version: u32) {
            assert(get_caller_address() == get_contract_address(), 'NOT_SELF');
            assert(self.migration_in_progress.read(), 'NOT_IN_MIGRATION');
            self.migration_ran.write(true);
            self.migrated_from.write(from_version);
        }

        fn migration_ran(self: @ContractState) -> bool {
            self.migration_ran.read()
        }

        fn migrated_from(self: @ContractState) -> u32 {
            self.migrated_from.read()
        }
    }
}

// Self-reports a DIFFERENT identity, so `upgrade` rejects it at the identity guard with
// 'NOT_SOL_ACCOUNT' - a foreign class cannot be installed.
#[starknet::contract]
pub mod WrongIdentityAccount {
    use super::IHasIdentity;

    #[storage]
    struct Storage {
        public_key: u256,
    }

    #[abi(embed_v0)]
    impl IdentityImpl of IHasIdentity<ContractState> {
        fn identity(self: @ContractState) -> felt252 {
            'not_sol'
        }
    }
}

// Has NO identity() entrypoint, so the `upgrade` identity guard's identity() library call
// fails (entrypoint not found) and reverts the upgrade - the absent-identity variant of
// the identity guard. It carries a lone unrelated entrypoint (a migration hook) purely so
// it is a well-formed, declarable class with something OTHER than identity().
#[starknet::contract]
pub mod AbsentIdentityAccount {
    use super::IHasMigrationHook;

    #[storage]
    struct Storage {
        public_key: u256,
    }

    #[abi(embed_v0)]
    impl HookImpl of IHasMigrationHook<ContractState> {
        fn execute_after_upgrade(ref self: ContractState, from_version: u32) {
            let _ = from_version;
        }
    }
}
