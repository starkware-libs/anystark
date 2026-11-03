// LIVE E2E: the full journey against a REAL Starknet Sepolia network.
// The offline twin of this suite is sponsored.e2e.test.ts, which drives the same
// PhantomConnector → SolanaAsStarknetAccount → garaga stack against a fully mocked
// fetch + a verifying mock SNIP-29 upstream. This suite instead points that exact
// same production stack at a REAL RPC and (optionally) a REAL paymaster: it does
// NOT mock globalThis.fetch — only window.phantom — so PhantomConnector runs
// byte-for-byte as a dapp runs it, signing with a real Ed25519 key derived from an
// env-provided seed, and everything else (sponsored deploy-and-invoke, SNIP-9
// outside execution, sponsorship) hits the chain for real.
//
// It is OPT-IN and SKIPPED by default: `npm test` collects it (it matches vitest's
// default *.test.ts include) but the whole suite self-skips unless EWC_E2E_SEPOLIA
// is set. An explicit opt-in must never silently no-op, so once enabled, missing
// required config THROWS (see beforeAll) rather than passing green.
//
// Environment matrix:
//   EWC_E2E_SEPOLIA=1            Master switch. Unset ⇒ the entire suite is skipped.
//   EWC_E2E_RPC_URL             (required in live mode) Sepolia JSON-RPC URL. The
//                               suite refuses to run if its chainId is not Sepolia.
//   EWC_E2E_SOLANA_SEED         (required in live mode) 64 hex chars (32-byte Ed25519
//                               seed) for the mock Phantom wallet. There is NO default:
//                               on a public network the locked-vector key (bytes 0..31)
//                               is anyone's, so we never fall back to it.
//   EWC_E2E_FUNDER_ADDRESS      (optional, paired) A pre-funded plain Starknet account…
//   EWC_E2E_FUNDER_PRIVATE_KEY  …and its private key. Enables the SNIP-9 outside-execution
//                               test, where the funder submits and pays for the account's
//                               signed outside execution (skips without a funder). The
//                               upgrade test also needs a funder but is ADDITIONALLY gated
//                               on EWC_E2E_UPGRADE=1.
//   EWC_E2E_PAYMASTER_URL       (optional) SNIP-29 paymaster URL. Every account operation
//                               runs sponsored through it, so it enables the sponsored
//                               deploy-and-invoke and the sponsored transfer/upgrade tests;
//                               those skip without it.
//   EWC_E2E_PAYMASTER_API_KEY   (optional) Sent as an `x-api-key` header to the paymaster.
//   EWC_E2E_UPGRADE=1           (optional) Enables the replace_class upgrade test (also
//                               needs a funder). Off by default — it mutates the account.
//
// Run just this suite: `npm run test:e2e:sepolia -w @starkware-libs/anystark-react`.
//
// The class hash is consumed ONLY via @starkware-libs/anystark-core's resolveDeployClassHash (the frozen
// deploy hash the address derives from), never hard-coded here, a wrong hash derives a
// different address and would send funds to an unintended account. The suite is
// idempotent across re-runs: the sol_account persists
// on-chain, so a deployed account simply skips the deploy leg on the next run.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type KeyObject } from "node:crypto";
import {
  Account,
  OutsideExecutionVersion,
  RpcProvider,
  hash,
  stark,
  type OutsideTransaction,
} from "starknet";
import {
  CHAIN_IDS,
  deriveSolAccountAddress,
  resolveDeployClassHash,
  type PaymasterConfig,
  type SolanaAsStarknetAccount,
} from "@starkware-libs/anystark-core";
import { PhantomConnector } from "./connector";
import {
  ISRC6_ID,
  ISRC9_V2_ID,
  installPhantom,
  seedToKeypair,
  strkBalance,
  strkTransfer,
  supportsInterface,
} from "./sepolia.e2e.helpers";

// Env gating (read once, at module load).
const IS_LIVE_MODE = process.env.EWC_E2E_SEPOLIA === "1";
const RPC_URL = process.env.EWC_E2E_RPC_URL;
const SOLANA_SEED = process.env.EWC_E2E_SOLANA_SEED;
const FUNDER_ADDRESS = process.env.EWC_E2E_FUNDER_ADDRESS;
const FUNDER_PRIVATE_KEY = process.env.EWC_E2E_FUNDER_PRIVATE_KEY;
const PAYMASTER_URL = process.env.EWC_E2E_PAYMASTER_URL;
const PAYMASTER_API_KEY = process.env.EWC_E2E_PAYMASTER_API_KEY;
const UPGRADE_ENABLED = process.env.EWC_E2E_UPGRADE === "1";
/** A funder is only usable when BOTH its address and key are present. */
const HAS_FUNDER = Boolean(FUNDER_ADDRESS && FUNDER_PRIVATE_KEY);

// On-chain constants.
/** The smallest possible transfer — enough to drive a real invoke without moving value. */
const TINY_AMOUNT = 1n;

// Deliberately-duplicated pin of the locked TS↔Cairo derivation vector.
// An intentional copy of the fund-safety vector in
// packages/core/src/key_to_address.test.ts (bytes 0..31 → this address, against the
// deploy class hash), also re-pinned in packages/react/src/sepolia.public.e2e.test.ts.
// It is duplicated on purpose: the core unit test pins the derivation math offline, and
// this live suite re-pins the SAME expectation while pointed at a real Sepolia RPC, so a
// drift in either the SDK derivation or the pinned class hash trips on the network too.
// Keep all three in lockstep.
const LOCKED_VECTOR_PUBKEY = Uint8Array.from(
  Array.from({ length: 32 }, (_, byteIndex) => byteIndex),
);
const LOCKED_VECTOR_ADDRESS = "0x3011dc8056908306c2c0fbf47a0d470318e1871323311951eff05d333bfc7b7";

// Live state, assigned in beforeAll (definite-assignment; guarded by the switch).
let provider!: RpcProvider;
let classHash!: string;
let walletPrivateKey!: KeyObject;
/** The env-seeded wallet's 32-byte Ed25519 public key (little-endian material for derivation). */
let pubkeyBytes!: Uint8Array;

/** Exactly what a dapp does: construct the connector, connect, take the account.
 *  A paymaster is required to construct the account. Read-only tests (address
 *  derivation, introspection, funder-submitted outside execution) never call
 *  execute(), so the placeholder default is never contacted; the sponsored tests
 *  pass the real EWC_E2E_PAYMASTER_URL config. */
async function connectedAccount(
  paymaster: PaymasterConfig = { nodeUrl: PAYMASTER_URL ?? "http://paymaster.unset.localhost" },
): Promise<SolanaAsStarknetAccount> {
  const connector = new PhantomConnector({
    starknetRpcUrl: RPC_URL as string,
    chainId: CHAIN_IDS.sepolia,
    paymaster,
  });
  await connector.connect();
  return (await connector.account()) as SolanaAsStarknetAccount;
}

/** A plain starknet.js Account for the pre-funded relayer/funder. The narrowing here
 *  proves both env vars are present, so no non-null assertions leak downstream. */
function requireFunder(): { account: Account; address: string } {
  if (!FUNDER_ADDRESS || !FUNDER_PRIVATE_KEY) {
    throw new Error(
      "funder requested but EWC_E2E_FUNDER_ADDRESS / EWC_E2E_FUNDER_PRIVATE_KEY unset",
    );
  }
  return {
    account: new Account({ provider, address: FUNDER_ADDRESS, signer: FUNDER_PRIVATE_KEY }),
    address: FUNDER_ADDRESS,
  };
}

describe.skipIf(!IS_LIVE_MODE)("sepolia live e2e", { timeout: 300_000 }, () => {
  beforeAll(async () => {
    // An explicit opt-in must never silently no-op: fail fast (before any network I/O)
    // with an actionable message when the required config is missing.
    if (!RPC_URL || !SOLANA_SEED) {
      throw new Error(
        "EWC_E2E_SEPOLIA=1 is set but required config is missing. Provide EWC_E2E_RPC_URL " +
          "(a Sepolia JSON-RPC URL) and EWC_E2E_SOLANA_SEED (64 hex chars / 32-byte Ed25519 seed). " +
          "There is deliberately no default seed — on a public network a shared key is anyone's.",
      );
    }
    // A funder is all-or-nothing: half a funder config is a silent mistake, not a valid
    // "no funder" state, so fail loud rather than skip the funder-gated tests unexpectedly.
    if (Boolean(FUNDER_ADDRESS) !== Boolean(FUNDER_PRIVATE_KEY)) {
      throw new Error(
        "Funder config is half-set: provide BOTH EWC_E2E_FUNDER_ADDRESS and " +
          "EWC_E2E_FUNDER_PRIVATE_KEY, or neither.",
      );
    }
    // An API key with no paymaster URL cannot reach a paymaster — treat it as a config error.
    if (PAYMASTER_API_KEY && !PAYMASTER_URL) {
      throw new Error(
        "EWC_E2E_PAYMASTER_API_KEY is set but EWC_E2E_PAYMASTER_URL is not. Provide the " +
          "paymaster URL, or unset the API key.",
      );
    }
    // Derive the Ed25519 keypair from the env seed (seedToKeypair throws on a malformed
    // seed), then install the mock Phantom that signs for real with it. PhantomConnector
    // wraps window.phantom.solana and runs unmodified; only the wallet is mocked (fetch
    // is NOT), so the connector runs byte-for-byte as a dapp runs it.
    ({ walletPrivateKey, pubkeyBytes } = seedToKeypair(SOLANA_SEED));
    installPhantom(pubkeyBytes, walletPrivateKey);

    // Preflight 1: guard against mainnet — a wrong-chain run could touch real funds.
    provider = new RpcProvider({ nodeUrl: RPC_URL });
    const chainId = await provider.getChainId();
    if (chainId !== CHAIN_IDS.sepolia) {
      throw new Error(
        `connected RPC reports chainId ${chainId}, not Sepolia (${CHAIN_IDS.sepolia}). ` +
          "Refusing to run the live suite against a non-Sepolia network.",
      );
    }

    // Preflight 2: resolve the deploy class hash from @starkware-libs/anystark-core (never hard-coded).
    classHash = resolveDeployClassHash({ chainId: CHAIN_IDS.sepolia });

    // Preflight 3: the class must be declared on-chain, or every derivation is against
    // a phantom class and no account can ever deploy.
    try {
      await provider.getClass(classHash);
    } catch {
      // Do NOT interpolate the raw error: it can echo the RPC URL, which may carry an
      // API key. A fixed remediation message is enough to act on, so the binding is dropped.
      throw new Error(
        `sol_account class ${classHash} is not declared on Sepolia (getClass failed). ` +
          "Declare it first:\n" +
          "  cd packages/contracts && scarb build && " +
          "starkli declare target/dev/sol_account_SolAccount.contract_class.json",
      );
    }
  }, 120_000);

  afterAll(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("derives the counterfactual address the connector reports (no funds needed)", async () => {
    const account = await connectedAccount();
    const expectedAddress = deriveSolAccountAddress(pubkeyBytes, classHash).address;
    expect(BigInt(account.address)).toBe(BigInt(expectedAddress));
    expect(BigInt(account.derivation.address)).toBe(BigInt(expectedAddress));

    // Independent cross-check 1 (not a tautology): the locked literal vector must still
    // derive its pinned address against the deploy class hash. The right-hand side is a
    // hard-coded literal, so this catches a drift in the derivation math or the class hash
    // even though both sides of the assertions above use the same runtime pubkey.
    expect(BigInt(deriveSolAccountAddress(LOCKED_VECTOR_PUBKEY, classHash).address)).toBe(
      BigInt(LOCKED_VECTOR_ADDRESS),
    );

    // Independent cross-check 2 (only once deployed): the sequencer itself certified the
    // address→class link at deploy time, so reading the on-chain class hash at the
    // derived address is a source of truth independent of our own derivation.
    if (await account.isDeployed()) {
      expect(BigInt(await provider.getClassHashAt(account.address))).toBe(BigInt(classHash));
    }
  });

  describe.skipIf(!PAYMASTER_URL)("sponsored deploy-and-invoke", () => {
    it("bundles the counterfactual deploy on first execute; the deploy class lands on-chain", async () => {
      const account = await connectedAccount({
        nodeUrl: PAYMASTER_URL as string,
        headers: PAYMASTER_API_KEY ? { "x-api-key": PAYMASTER_API_KEY } : undefined,
      });

      // The first sponsored execute() bundles the counterfactual deploy via SNIP-29
      // deploy_and_invoke; the paymaster pays. Idempotent across re-runs: a deployed
      // account plain-invokes instead. A self-transfer nets zero value movement.
      const invokeResult = await account.execute([strkTransfer(account.address, TINY_AMOUNT)]);
      const receipt = await provider.waitForTransaction(invokeResult.transaction_hash);

      expect(receipt.isSuccess()).toBe(true);
      expect(await account.isDeployed()).toBe(true);
      expect(BigInt(await provider.getClassHashAt(account.address))).toBe(BigInt(classHash));
    });
  });

  it("exposes SRC5: supports_interface is true for ISRC6 and ISRC9_V2", async (ctx) => {
    const account = await connectedAccount();
    // Introspection needs the account deployed; if a funder didn't deploy it (and no
    // prior run did), there is nothing to introspect — skip rather than fail.
    if (!(await account.isDeployed())) ctx.skip();

    expect(await supportsInterface(provider, account.address, ISRC6_ID)).toBe(true);
    expect(await supportsInterface(provider, account.address, ISRC9_V2_ID)).toBe(true);
  });

  it.skipIf(!HAS_FUNDER)(
    "executes a SNIP-9 v2 outside execution submitted (and paid for) by the funder",
    async (ctx) => {
      const account = await connectedAccount();
      if (!(await account.isDeployed())) ctx.skip();
      const { account: funder, address: funderAddress } = requireFunder();

      // The sol account signs the outside execution (bound to the funder as sole caller);
      // the funder submits execute_from_outside_v2 and pays the gas. Fresh random nonce.
      const nowSeconds = Math.floor(Date.now() / 1000);
      const outsideTx: OutsideTransaction = await account.getOutsideTransaction(
        {
          caller: funder.address,
          execute_after: nowSeconds - 3600,
          execute_before: nowSeconds + 3600,
        },
        [strkTransfer(funderAddress, TINY_AMOUNT)],
        OutsideExecutionVersion.V2,
        stark.randomAddress(),
      );

      const accountBalanceBefore = await strkBalance(provider, account.address);
      const invokeResult = await funder.executeFromOutside(outsideTx);
      const receipt = await provider.waitForTransaction(invokeResult.transaction_hash);

      expect(receipt.isSuccess()).toBe(true);
      // The funder paid the gas, so the sol account's only debit is the inner transfer.
      expect(accountBalanceBefore - (await strkBalance(provider, account.address))).toBe(
        TINY_AMOUNT,
      );
    },
  );

  describe.skipIf(!PAYMASTER_URL)("sponsored execution via SNIP-29 paymaster", () => {
    it("executes a sponsored transfer the sol account pays no fee for", async (ctx) => {
      const account = await connectedAccount({
        nodeUrl: PAYMASTER_URL as string,
        headers: PAYMASTER_API_KEY ? { "x-api-key": PAYMASTER_API_KEY } : undefined,
      });
      // Sponsorship still executes as the account, which must already be deployed; if no
      // funder (or prior run) deployed it, there is nothing to sponsor — skip rather than fail.
      if (!(await account.isDeployed())) ctx.skip();

      // A self-transfer nets zero value movement, so any balance change would be a fee.
      // Under sponsorship the paymaster pays gas — assert the account balance is unchanged.
      const balanceBefore = await strkBalance(provider, account.address);
      const invokeResult = await account.execute([strkTransfer(account.address, TINY_AMOUNT)]);
      const receipt = await provider.waitForTransaction(invokeResult.transaction_hash);

      expect(receipt.isSuccess()).toBe(true);
      expect(await strkBalance(provider, account.address)).toBe(balanceBefore);
    });
  });

  // Last, and off by default: it mutates the account's class. It defaults to upgrading to
  // the single pinned class - a brick-free swap today (the target is identical to the
  // deployed class, and the contract rejects only the zero class) that still exercises the
  // full replace_class path. Set EWC_E2E_UPGRADE_TARGET_CLASS_HASH to a genuinely different
  // (and already-declared) class to round-trip a real class change.
  describe.skipIf(!UPGRADE_ENABLED || !HAS_FUNDER || !PAYMASTER_URL)(
    "upgrade via replace_class",
    () => {
      it("emits Upgraded(target) and lands the target class on-chain", async (ctx) => {
        // upgrade runs sponsored like every account operation, so it needs a paymaster.
        const account = await connectedAccount({
          nodeUrl: PAYMASTER_URL as string,
          headers: PAYMASTER_API_KEY ? { "x-api-key": PAYMASTER_API_KEY } : undefined,
        });
        if (!(await account.isDeployed())) ctx.skip();
        const { address: funderAddress } = requireFunder();

        // Default: upgrade to the single pinned class (brick-free; identical to the deployed
        // class today). Override with an already-declared different class for a real
        // class-change round-trip.
        const targetClassHash =
          process.env.EWC_E2E_UPGRADE_TARGET_CLASS_HASH ??
          resolveDeployClassHash({ chainId: CHAIN_IDS.sepolia });
        const upgradeResult = await account.execute([
          { contractAddress: account.address, entrypoint: "upgrade", calldata: [targetClassHash] },
        ]);
        const receipt = await provider.waitForTransaction(upgradeResult.transaction_hash);
        expect(receipt.isSuccess()).toBe(true);

        // The contract emits exactly one Upgraded { class_hash } from its own address, with
        // the target class in data[0] (the event has no #[key] on class_hash, so keys[0] is
        // just the event selector). `receipt.value` is the raw receipt union (its Error
        // member has no events); the isSuccess() check above guarantees a success receipt, so
        // narrow to the emitted-event shape (data[0] carries the requested target class hash).
        const upgradedSelector = BigInt(hash.getSelectorFromName("Upgraded"));
        const events = (
          receipt.value as {
            events: Array<{ from_address: string; keys: string[]; data: string[] }>;
          }
        ).events;
        const upgradedEvents = events.filter(
          (event) =>
            BigInt(event.from_address) === BigInt(account.address) &&
            BigInt(event.keys?.[0]) === upgradedSelector,
        );
        expect(upgradedEvents).toHaveLength(1);
        expect(BigInt(upgradedEvents[0].data[0])).toBe(BigInt(targetClassHash));

        // The on-chain class at the account is now the requested target (independent source).
        expect(BigInt(await provider.getClassHashAt(account.address))).toBe(
          BigInt(targetClassHash),
        );

        // A follow-up invoke still succeeds through the (re-applied) validation logic.
        const followUpResult = await account.execute([strkTransfer(funderAddress, TINY_AMOUNT)]);
        expect(
          (await provider.waitForTransaction(followUpResult.transaction_hash)).isSuccess(),
        ).toBe(true);
      });
    },
  );
});
