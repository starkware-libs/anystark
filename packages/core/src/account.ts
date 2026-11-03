// ─── SolanaAsStarknetAccount ───
// A starknet.js Account subclass whose signatures come from a Solana wallet
// (via SolanaAsStarknetSigner) and whose address is the counterfactual sol_account address.
//
// It's an Account *subclass* (not a wrapper) on purpose: any caller of the
// standard AccountInterface (notably @starknet-react's useSendTransaction, which
// calls `account.execute()`) must run paymaster-sponsored through the configured
// SNIP-29 paymaster. Putting that logic in `execute()` makes the account genuinely
// drop-in, with no Phantom-specific branching in dapp code.
//
// The account is counterfactual: its address exists (and can receive CCTP mints)
// before any code is deployed. The first sponsored `execute()` bundles the
// counterfactual deploy via SNIP-29 `deploy_and_invoke` through the paymaster.

import {
  Account,
  CallData,
  RpcError,
  RpcProvider,
  hash,
  num,
  shortString,
  stark,
  type AllowArray,
  type Call,
  type ExecutableUserTransaction,
  type ExecutionParameters,
  type InvokeFunctionResponse,
  type PaymasterDetails,
  type PaymasterFeeEstimate,
  type PreparedTransaction,
  type UniversalDetails,
  type UserTransaction,
} from "starknet";
import { type PaymasterConfig, type PaymasterFeeMode } from "./config";
import { deriveSolAccountAddress, type SolAccountDerivation } from "./key_to_address";
import { SolanaAsStarknetSigner, type SigningLabel, type SolanaSigner } from "./signer";

export interface CreateSolanaAccountParams {
  /** The Solana wallet's signing capability backing the account (pubkey + raw-bytes signer). */
  signer: SolanaSigner;
  /** Starknet JSON-RPC URL. */
  rpcUrl: string;
  /** Pinned sol_account class hash (resolve via `resolveDeployClassHash`). The derived address
   *  depends on it — a wrong hash yields an uncontrollable address. */
  classHash: string;
  /** SNIP-29 paymaster (REQUIRED): the account always executes sponsored through it. */
  paymaster: PaymasterConfig;
  /** Optional human-readable label placed before the base64 hash in every signed
   *  message, separated from it by a single `\n`, so the wallet popup shows the user
   *  what they approve. Default none (44-byte message, cheapest). Rejected before
   *  signing if it would exceed the 258-byte budget (see `assembleSignedMessage` for
   *  the length/gas tradeoff). Pass a `LabeledExecutor` instead of a string to label
   *  each action separately; see `PhantomConnectorConfig.signingLabel` for the full
   *  contract. */
  signingLabel?: SigningLabel;
}

// The STARK field prime; a class hash is a felt, so it must be in [1, PRIME).
const STARK_PRIME = 2n ** 251n + 17n * 2n ** 192n + 1n;

// Validate an upgrade target class hash BEFORE it reaches the wire. A missing,
// zero, non-hex, or out-of-field value is a client mistake — reject it here with
// a descriptive message rather than emit a transaction the contract would revert
// (`'ZERO_CLASS'`) or that would derive garbage calldata. Returns the value
// normalized to a canonical hex felt so the on-wire calldata is well-formed
// regardless of the caller's input encoding.
function validateClassHash(classHash: string): string {
  if (!classHash) {
    throw new Error(
      "upgrade: classHash is missing or empty; pass a declared class hash to upgrade to.",
    );
  }
  let value: bigint;
  try {
    value = BigInt(classHash);
  } catch {
    throw new Error(`upgrade: classHash ${classHash} is not a valid felt.`);
  }
  if (value === 0n) {
    throw new Error(
      "upgrade: classHash is zero; the contract rejects the zero class ('ZERO_CLASS').",
    );
  }
  // Reject negatives too: BigInt("-1") parses fine but is not a felt, and would
  // otherwise slip through to a malformed "0x-1" hex encoding.
  if (value <= 0n || value >= STARK_PRIME) {
    throw new Error(`upgrade: classHash ${classHash} is out of the felt range.`);
  }
  return num.toHex(value);
}

// SNIP-29 protocol literals: the execution-parameters version and the only
// account-deployment payload version the spec defines.
const SNIP29_EXECUTION_VERSION = "0x1";
const SNIP29_DEPLOYMENT_VERSION = 1;
/** Fee mode when PaymasterConfig leaves it out: the paymaster service pays. */
const DEFAULT_FEE_MODE: PaymasterFeeMode = { mode: "sponsored" };

// starknet.js exposes these SNIP-29 shapes only as members of other types.
type AccountDeploymentData = NonNullable<PaymasterDetails["deploymentData"]>;
type PaymasterTypedData = Extract<PreparedTransaction, { typed_data: unknown }>["typed_data"];
// A single SNIP-9 v2 call in the typed data's message (To / Selector / Calldata).
type PaymasterTypedDataCall = Extract<
  PaymasterTypedData["message"],
  { Calls: unknown }
>["Calls"][number];

// A SNIP-12 chainId may be encoded either as a hex/decimal felt (the form the RPC
// getChainId() returns) or as its ASCII shortstring (e.g. "SN_SEPOLIA", also a
// valid SNIP-12 encoding). Normalize either form to the felt so a same-chain
// paymaster using the shortstring form compares equal — and so a truly foreign
// value yields a CLEAN chain-mismatch rejection rather than an opaque
// BigInt(...) SyntaxError.
function toChainIdFelt(value: string | number): bigint | undefined {
  try {
    return BigInt(value);
  } catch {
    if (typeof value !== "string") return undefined;
    try {
      return BigInt(shortString.encodeShortString(value));
    } catch {
      return undefined;
    }
  }
}

// ─── Confused-deputy guard ───
// paymaster_buildTransaction returns the SNIP-9 typed data the wallet is asked
// to sign, which makes the response attacker-controlled input: a malicious (or
// compromised) paymaster that slips in an extra call or mutates calldata would
// obtain a valid account signature over calls that drain it. starknet.js's own
// executePaymasterTransaction cross-checks the calls only in the "default"
// (gas-token) fee mode and not at all when sponsored, so the SDK verifies here —
// before anything is signed — that the returned calls are exactly the requested
// ones, plus (in "default" mode only) the single gas-token transfer the
// paymaster appends to repay itself, bounded by the caller's fee ceiling.
function assertTypedDataMatchesRequest(
  typedData: PaymasterTypedData,
  requested: Call[],
  feeMode: PaymasterFeeMode,
  fee: PaymasterFeeEstimate,
  expectedChainId: string,
): void {
  // sol_account implements SNIP-9 v2 only; v1 typed data would yield a signature
  // the account can never consume — reject rather than sign blind.
  const message = typedData.message;
  if (!("Calls" in message)) {
    throw new Error("Paymaster returned non-SNIP-9-v2 typed data (message has no Calls).");
  }
  // The counterfactual address is chain-independent (it derives from pubkey +
  // class hash), so a wrong-chain domain would still fold OUR address into the
  // SNIP-12 hash and yield a signature valid on that other network. Pin the domain
  // to the account's chain. (execute_after/execute_before/caller are paymaster-
  // owned under SNIP-29 and left unpinned on purpose: the outside-execution nonce
  // makes the bundle single-use, so a far-future window is at worst a delayed —
  // never duplicated or redirected — execution of calls the user already pinned.)
  const domainChainId = typedData.domain.chainId;
  const domainFelt = domainChainId === undefined ? undefined : toChainIdFelt(domainChainId);
  if (domainFelt === undefined || domainFelt !== BigInt(expectedChainId)) {
    throw new Error(
      `Paymaster typed data domain chainId ${String(domainChainId)} does not match the ` +
        `account's chain ${expectedChainId}.`,
    );
  }
  const returned = message.Calls;
  const expectedCount = feeMode.mode === "default" ? requested.length + 1 : requested.length;
  if (returned.length !== expectedCount) {
    throw new Error(
      `Paymaster typed data has ${returned.length} calls, expected ${expectedCount}: ` +
        "refusing to sign calls that were not requested.",
    );
  }
  requested.forEach((call, i) => {
    // Name the divergent field (an integrator debugging a real paymaster needs
    // more than "call #i mismatched"). Selector is compared as
    // getSelectorFromName(entrypoint) to mirror starknet.js's convertCalls wire
    // serialization (both text-hash the entrypoint); keep in lockstep if
    // starknet.js ever moves convertCalls to selector-aware hashing.
    const got = returned[i];
    if (BigInt(got.To) !== BigInt(call.contractAddress)) {
      throw new Error(
        `Paymaster typed data call #${i} does not match the requested call: ` +
          `To ${String(got.To)} != ${call.contractAddress}.`,
      );
    }
    if (BigInt(got.Selector) !== BigInt(hash.getSelectorFromName(call.entrypoint))) {
      throw new Error(
        `Paymaster typed data call #${i} does not match the requested call: ` +
          `Selector ${String(got.Selector)} != ${call.entrypoint}.`,
      );
    }
    const expectedCalldata = CallData.toCalldata(call.calldata);
    const returnedCalldata = CallData.toCalldata(got.Calldata);
    if (returnedCalldata.length !== expectedCalldata.length) {
      throw new Error(
        `Paymaster typed data call #${i} does not match the requested call: ` +
          `calldata length ${returnedCalldata.length} != ${expectedCalldata.length}.`,
      );
    }
    expectedCalldata.forEach((felt, j) => {
      if (BigInt(returnedCalldata[j]) !== BigInt(felt)) {
        throw new Error(
          `Paymaster typed data call #${i} does not match the requested call: ` +
            `calldata[${j}] ${String(returnedCalldata[j])} != ${String(felt)}.`,
        );
      }
    });
  });
  if (feeMode.mode === "default") {
    assertGasTokenRepayment(returned[requested.length], feeMode, fee);
  }
}

// "default" fee mode: the paymaster appends ONE call that repays it in the gas
// token. starknet.js's assertPaymasterTransactionSafety binds this call's amount
// ONLY when a maxFeeInGasToken ceiling is passed (verified in starknet 8.9.2
// dist), so we bind it here unconditionally: To == the configured gas token,
// selector == transfer, amount == the quoted suggested_max_fee_in_gas_token, and
// that quote <= the caller's ceiling. The recipient (calldata[0]) is intentionally
// NOT pinned — starknet.js does not pin it either, and with the amount capped at
// the caller ceiling a wrong recipient costs the paymaster its repayment, never
// more than maxFeeInGasToken of the user's gas token.
function assertGasTokenRepayment(
  appended: PaymasterTypedDataCall,
  feeMode: { mode: "default"; gasToken: string; maxFeeInGasToken: bigint },
  fee: PaymasterFeeEstimate,
): void {
  if (BigInt(appended.To) !== BigInt(feeMode.gasToken)) {
    throw new Error(
      `Paymaster fee-repayment call is to ${String(appended.To)}, not the configured ` +
        `gas token ${feeMode.gasToken}.`,
    );
  }
  // Only a direct ERC-20 `transfer` is accepted as the repayment; approve /
  // transferFrom / router-mediated repayments are rejected pre-sign. This is
  // INTENTIONALLY strict: `transfer` is the standard SNIP-29 gas-token repayment,
  // and widening the selector set would weaken the guard with no known need. If
  // default/gas-token mode is ever exercised against a live paymaster, re-confirm
  // with the upstream (AVNU) that repayment is always a direct transfer; only then,
  // and only if required, widen here while keeping the To + amount<=ceiling binding.
  if (BigInt(appended.Selector) !== BigInt(hash.getSelectorFromName("transfer"))) {
    throw new Error("Paymaster fee-repayment call is not an ERC-20 transfer.");
  }
  const suggested = BigInt(fee.suggested_max_fee_in_gas_token);
  if (suggested > feeMode.maxFeeInGasToken) {
    throw new Error(
      `Paymaster gas-token fee ${suggested} exceeds the configured maxFeeInGasToken ` +
        `${feeMode.maxFeeInGasToken}.`,
    );
  }
  // ERC-20 transfer(recipient, amount: u256) → [recipient, amount_low, amount_high].
  const calldata = CallData.toCalldata(appended.Calldata);
  const amountLow = calldata.length > 1 ? BigInt(calldata[1]) : 0n;
  const amountHigh = calldata.length > 2 ? BigInt(calldata[2]) : 0n;
  if (amountHigh !== 0n || amountLow !== suggested) {
    throw new Error(
      `Paymaster fee-repayment amount ${amountLow}` +
        `${amountHigh ? ` (high limb ${amountHigh})` : ""} does not equal the quoted fee ${suggested}.`,
    );
  }
}

// The build response echoes the deployment payload; a different address or class
// there means the paymaster intends to deploy something other than this account —
// misbehavior worth failing on before signing. (What actually executes is bound
// tighter still: executeTransaction is sent OUR payload, and the signed SNIP-12
// hash folds in the account address.)
function assertDeploymentEchoMatches(
  echoed: AccountDeploymentData,
  sent: AccountDeploymentData,
): void {
  if (BigInt(echoed.address) !== BigInt(sent.address)) {
    throw new Error(
      `Paymaster deployment echo: address ${echoed.address} != sent ${sent.address}.`,
    );
  }
  if (BigInt(echoed.class_hash) !== BigInt(sent.class_hash)) {
    throw new Error(
      `Paymaster deployment echo: class_hash ${echoed.class_hash} != sent ${sent.class_hash}.`,
    );
  }
  if (BigInt(echoed.salt) !== BigInt(sent.salt)) {
    throw new Error(`Paymaster deployment echo: salt ${echoed.salt} != sent ${sent.salt}.`);
  }
  if (echoed.calldata.length !== sent.calldata.length) {
    throw new Error(
      `Paymaster deployment echo: calldata length ${echoed.calldata.length} != ` +
        `sent ${sent.calldata.length}.`,
    );
  }
  sent.calldata.forEach((felt, i) => {
    if (BigInt(echoed.calldata[i]) !== BigInt(felt)) {
      throw new Error(
        `Paymaster deployment echo: calldata[${i}] ${echoed.calldata[i]} != sent ${felt}.`,
      );
    }
  });
}

export class SolanaAsStarknetAccount extends Account {
  /** The counterfactual-address derivation (salt, calldata, limbs, address). */
  readonly derivation: SolAccountDerivation;
  /** SNIP-29 paymaster config; execute() always runs sponsored through it (see executeSponsored). */
  readonly paymasterConfig: PaymasterConfig;
  private readonly classHash: string;
  private readonly rpc: RpcProvider;
  /** The first sponsored execute() before deployment bundles the deploy
   *  (deploy_and_invoke); concurrent calls await this until that transaction is
   *  accepted instead of bundling a second one. Assigned synchronously (before the
   *  isDeployed() probe) to close that TOCTOU window. Resolves on acceptance;
   *  cleared on failure so a later execute() can retry. */
  private sponsoredDeployPromise?: Promise<void>;
  /** Positive deployment cache: once we observe (or complete) a deployment we skip
   *  the getClassHashAt probe on every later execute(). Fail-open: unknown stays
   *  false and we probe. */
  private deployed = false;

  constructor(params: CreateSolanaAccountParams) {
    const { signer, rpcUrl, classHash, paymaster, signingLabel } = params;
    const derivation = deriveSolAccountAddress(signer.pubkey, classHash);
    const provider = new RpcProvider({ nodeUrl: rpcUrl });
    super({
      provider,
      address: derivation.address,
      signer: new SolanaAsStarknetSigner(signer, signingLabel),
      cairoVersion: "1",
      // Only the transport half of the config (feeMode is applied per execute()).
      // Sponsored is the only execution path, so the transport is always passed.
      paymaster: { nodeUrl: paymaster.nodeUrl, headers: paymaster.headers },
    });
    this.derivation = derivation;
    this.classHash = classHash;
    this.rpc = provider;
    this.paymasterConfig = paymaster;
  }

  /** Whether the account contract is already deployed at its address. */
  async isDeployed(): Promise<boolean> {
    try {
      await this.rpc.getClassHashAt(this.address);
      return true;
    } catch (err) {
      // Only an undeployed account legitimately has no class hash; any other RPC
      // error (network, node) must not be silently reported as "not deployed".
      if (err instanceof RpcError && err.isType("CONTRACT_NOT_FOUND")) return false;
      throw err;
    }
  }

  // Override so every caller (incl. @starknet-react's useSendTransaction) runs
  // sponsored through the paymaster; the base Account.execute() would instead submit
  // an unsponsored protocol invoke the account cannot pay for. transactionsDetail
  // (nonce, resourceBounds, version, …) is paymaster-owned under SNIP-29, so it is
  // ignored; the parameter stays only for AccountInterface compatibility.
  override async execute(
    transactions: AllowArray<Call>,
    transactionsDetail?: UniversalDetails,
  ): Promise<InvokeFunctionResponse> {
    void transactionsDetail;
    return this.executeSponsored([transactions].flat());
  }

  // ─── Class upgrade (replace_class) ───

  /** Upgrade this account's class via the self-authorized `upgrade` entrypoint
   *  (an in-account `replace_class`). MANUAL and user-driven: `newClassHash` is
   *  REQUIRED (the SDK pins a single frozen class and does not track a "latest"
   *  upgrade target), and this is never auto-triggered — the caller decides when
   *  and to what to upgrade.
   *
   *  Fund-safety guards, all BEFORE anything is sent:
   *   - the target is validated as a non-zero, in-range felt (the contract rejects
   *     the zero class, and a malformed hash would derive garbage calldata);
   *   - the target class is confirmed DECLARED on-chain (getClass), because
   *     upgrading to an undeclared class permanently bricks the account — this
   *     turns that mistake into a client-side error instead of a lost account.
   *
   *  Storage-layout warning: `replace_class` preserves the storage tree, so any
   *  replacement class MUST keep the `public_key: u256` field at the same
   *  name-derived slot (see packages/contracts/README.md). A class that moves it
   *  orphans the root signer that derives the user's address.
   *
   *  upgrade runs sponsored through the paymaster like every account operation; a
   *  paymaster whose policy does not allowlist the `upgrade` self-call rejects it
   *  (surfaced as an error). */
  async upgrade(newClassHash: string): Promise<InvokeFunctionResponse> {
    const targetClassHash = validateClassHash(newClassHash);
    // Pre-flight: the class must be declared on this network. getClass throws
    // CLASS_HASH_NOT_FOUND for an undeclared class; surface it as a clear,
    // actionable client error rather than let the caller brick the account.
    try {
      await this.rpc.getClass(targetClassHash);
    } catch (err) {
      if (err instanceof RpcError && err.isType("CLASS_HASH_NOT_FOUND")) {
        throw new Error(
          `upgrade: class ${targetClassHash} is not declared on this network; ` +
            "pass the hash of a published version (upgrading to an undeclared class bricks the account).",
        );
      }
      throw err;
    }
    return this.execute([
      { contractAddress: this.address, entrypoint: "upgrade", calldata: [targetClassHash] },
    ]);
  }

  // ─── SNIP-29 sponsored execution ───

  /** Sponsored execute(): the paymaster wraps `calls` in a SNIP-9 outside
   *  execution, the wallet signs its typed data, and the service submits (and
   *  pays for) the resulting transaction. Paymaster errors propagate as-is. */
  private async executeSponsored(calls: Call[]): Promise<InvokeFunctionResponse> {
    const feeMode = this.paymasterConfig.feeMode ?? DEFAULT_FEE_MODE;
    // Steady state: a known-deployed account skips the getClassHashAt probe.
    if (this.deployed) {
      return this.submitSponsored(calls, feeMode);
    }
    if (this.sponsoredDeployPromise) {
      // A first-use deploy is already in flight; wait for it to be accepted
      // instead of bundling a second deployment (the second would revert), then
      // issue a plain invoke.
      await this.sponsoredDeployPromise;
      return this.submitSponsored(calls, feeMode);
    }
    // We are the first execute(). `flow` resolves at SUBMIT time (with this caller's
    // deploy_and_invoke response, or undefined if the account was already deployed);
    // `sponsoredDeployPromise` chains off it and resolves at ACCEPTANCE, gating any
    // concurrent caller so its follow-up invoke can't hit an undeployed account.
    // Both are assigned synchronously, before the isDeployed() suspension point,
    // so a concurrent first execute() takes the branch above rather than racing into
    // a second deploy bundle.
    const flow = (async (): Promise<InvokeFunctionResponse | undefined> => {
      if (await this.isDeployed()) {
        this.deployed = true;
        return undefined;
      }
      // Undeployed: bundle the counterfactual deployment into this first sponsored
      // transaction (deploy_and_invoke). A paymaster that rejects deployments
      // surfaces as an error; the alternative is operator pre-deployment via UDC.
      return this.submitSponsored(calls, feeMode, this.deploymentData());
    })();
    this.sponsoredDeployPromise = flow
      .then(async (submitted) => {
        if (submitted) {
          // Off THIS caller's critical path (it already has its tx hash); only
          // concurrent callers await this before their plain invoke.
          await this.rpc.waitForTransaction(submitted.transaction_hash);
          this.deployed = true;
        }
      })
      .catch((err) => {
        // Reset on failure (build/sign/submit or acceptance) so the next execute()
        // retries with a fresh deployment.
        this.sponsoredDeployPromise = undefined;
        throw err;
      });
    // The memo may go unawaited (no concurrent caller); don't leak a rejection.
    this.sponsoredDeployPromise.catch(() => {});
    const submitted = await flow;
    // If this caller bundled the deploy, its invoke result is already in hand;
    // otherwise the account was deployed and we still owe a plain sponsored invoke.
    return submitted ?? this.submitSponsored(calls, feeMode);
  }

  /** SNIP-29 deployment payload for the counterfactual deploy — the same class
   *  hash / salt / calldata as the counterfactual address derivation. sol_account's
   *  constructor takes no signature, so `sigdata` stays absent. */
  private deploymentData(): AccountDeploymentData {
    return {
      address: this.address,
      class_hash: this.classHash,
      salt: this.derivation.salt,
      calldata: this.derivation.calldata,
      version: SNIP29_DEPLOYMENT_VERSION,
    };
  }

  // The explicit build → verify → sign → execute pipeline, deliberately NOT
  // Account.executePaymasterTransaction: that helper signs sponsored typed data
  // without any call-integrity check, and even in "default" mode binds the
  // appended gas-token amount only when a maxFeeInGasToken is passed (see
  // assertTypedDataMatchesRequest, which binds both modes here). Going straight to
  // the paymaster also skips its SNIP-9 introspection round-trip — the pinned
  // sol_account class embeds SRC9 v2, so the capability is static.
  private async submitSponsored(
    calls: Call[],
    feeMode: PaymasterFeeMode,
    deployment?: AccountDeploymentData,
  ): Promise<InvokeFunctionResponse> {
    const parameters: ExecutionParameters = {
      version: SNIP29_EXECUTION_VERSION,
      // starknet's on-the-wire FeeMode has no caller ceiling; strip our
      // maxFeeInGasToken extension (the guard enforces it locally).
      feeMode:
        feeMode.mode === "default" ? { mode: "default", gasToken: feeMode.gasToken } : feeMode,
    };
    const invoke = { userAddress: this.address, calls };
    const request: UserTransaction = deployment
      ? { type: "deploy_and_invoke", deployment, invoke }
      : { type: "invoke", invoke };
    const prepared = await this.paymaster.buildTransaction(request, parameters);
    // The explicit "deploy" check looks redundant (request.type is never "deploy")
    // but is load-bearing TS narrowing: comparing against the non-literal
    // request.type narrows nothing, so only this excludes the PreparedDeploy variant
    // that has no typed_data, letting prepared.typed_data typecheck below.
    if (prepared.type === "deploy" || prepared.type !== request.type) {
      throw new Error(
        `Paymaster changed the transaction type (requested "${request.type}", got "${prepared.type}").`,
      );
    }
    assertTypedDataMatchesRequest(
      prepared.typed_data,
      calls,
      feeMode,
      prepared.fee,
      await this.getChainId(),
    );
    if (prepared.type === "deploy_and_invoke" && deployment) {
      assertDeploymentEchoMatches(prepared.deployment, deployment);
    }
    // Signing folds this.address into the SNIP-12 hash (getMessageHash), so the
    // signature is bound to THIS account and cannot be redirected to another.
    const signature = await this.signer.signMessage(prepared.typed_data, this.address);
    const signedInvoke = {
      userAddress: this.address,
      typedData: prepared.typed_data,
      signature: stark.formatSignature(signature),
    };
    const executable: ExecutableUserTransaction = deployment
      ? { type: "deploy_and_invoke", deployment, invoke: signedInvoke }
      : { type: "invoke", invoke: signedInvoke };
    const { transaction_hash } = await this.paymaster.executeTransaction(executable, parameters);
    return { transaction_hash };
  }
}
