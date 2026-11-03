// ─── E2E: the sponsored-execution journey, through the full production stack ───
// "End to end" here means every line of PRODUCTION code a dapp exercises —
// PhantomConnector → SolanaAsStarknetAccount → SolanaAsStarknetSigner → garaga
// felt encoding — driven exactly the way a dapp drives it (connect() →
// account() → execute(calls)), against a mock Phantom that signs with a REAL
// Ed25519 key and a mock SNIP-29 upstream that cryptographically VERIFIES
// everything reaching it (signer binding, SNIP-12 message binding, and a real
// Ed25519 check of the reconstructed 64-byte signature). There is deliberately
// no devnet: a network run is gated on the sol_account class being declared and
// the account being whitelisted by a live paymaster service, so THIS suite is
// the merge gate for the sponsored path.
//
// The forwarding proxy is deliberately not in the loop: it forwards
// the SNIP-29 namespace verbatim and has its own tests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// starknet.js binds globalThis.fetch once, at module load (its internal
// fetch_default), so the mock must exist BEFORE the starknet import below —
// vi.hoisted runs ahead of the hoisted ESM imports. Tests swap implementations
// via mockRpc(); the function object itself must stay this one.
const { fetchMock, realFetch } = vi.hoisted(() => {
  const realFetch = globalThis.fetch;
  const fetchMock = vi.fn<(url: unknown, init?: RequestInit) => Promise<Response>>();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return { fetchMock, realFetch };
});

import {
  createPrivateKey,
  createPublicKey,
  sign as ed25519Sign,
  verify as ed25519Verify,
} from "node:crypto";
import {
  OutsideExecutionVersion,
  constants,
  hash,
  outsideExecution,
  typedData as snip12,
  type Call,
  type TypedData,
} from "starknet";
import {
  CHAIN_IDS,
  deriveSolAccountAddress,
  feltToBase64Hash,
  resolveDeployClassHash,
  type PaymasterConfig,
  type SolanaAsStarknetAccount,
} from "@starkware-libs/anystark-core";
import { PhantomConnector } from "./connector";

// ─── The locked test wallet (real Ed25519, seed bytes 0..31) ───
// Self-contained copy of @starkware-libs/anystark-core's locked vector (src/test_vectors.ts): that
// file is not part of core's public surface, so the wallet is re-derived here
// instead of deep-importing across packages. LOCKED_PUBKEY is the seed-0..31
// public key; do not edit without re-verifying against core's vector.

/** PKCS8/SPKI DER prefixes that wrap raw Ed25519 key bytes into import-able keys. */
const ED25519_PKCS8_PREFIX = "302e020100300506032b657004220420";
const ED25519_SPKI_PREFIX = "302a300506032b6570032100";
// prettier-ignore
const LOCKED_PUBKEY = Uint8Array.from([3, 161, 7, 191, 243, 206, 16, 190, 29, 112, 221, 24, 231, 75, 192, 153, 103, 228, 214, 48, 155, 165, 13, 95, 29, 220, 134, 100, 18, 85, 49, 184]);
const SEED = Uint8Array.from({ length: 32 }, (_, i) => i);
const walletPrivateKey = createPrivateKey({
  key: Buffer.concat([Buffer.from(ED25519_PKCS8_PREFIX, "hex"), Buffer.from(SEED)]),
  format: "der",
  type: "pkcs8",
});
const walletPublicKey = createPublicKey({
  key: Buffer.concat([Buffer.from(ED25519_SPKI_PREFIX, "hex"), Buffer.from(LOCKED_PUBKEY)]),
  format: "der",
  type: "spki",
});

/** Install a mock Phantom provider that signs for real with the locked key —
 *  the connector-side twin of connector.test.ts's setPhantom, minus the fakes.
 *  Returns the spied `signMessage` (the terminal wallet-sign call) so a test can
 *  prove a rejection happened BEFORE signing, not merely before execution. */
function installPhantom() {
  const publicKey = { toBytes: () => LOCKED_PUBKEY, toString: () => "LockedTestWallet" };
  const signMessage = vi.fn(async (message: Uint8Array) => ({
    signature: new Uint8Array(ed25519Sign(null, message, walletPrivateKey)),
    publicKey,
  }));
  const provider = {
    isPhantom: true,
    publicKey,
    connect: async () => ({ publicKey }),
    disconnect: async () => {},
    signMessage,
    signAndSendTransaction: async () => ({ signature: "unused" }),
    on: () => {},
    removeListener: () => {},
  };
  (globalThis as { window?: unknown }).window = { phantom: { solana: provider } };
  return { signMessage };
}

// ─── JSON-RPC transport ───
// JsonRpcError, mockRpc and the vi.hoisted fetch block above are copied — not
// imported — from core's account.test.ts, for the same public-surface reason as
// the locked wallet above (test harness is not part of core's published API).
// Keep the two routers in sync by hand; extract a shared test util if a third
// consumer appears.

/** A JSON-RPC error for a mock handler to return instead of a `result`. */
class JsonRpcError {
  constructor(
    readonly code: number,
    readonly message: string,
  ) {}
}

/** Route JSON-RPC requests to per-method handlers. Returns the ordered log of
 *  requested methods for may/may-not-touch assertions. */
function mockRpc(handlers: Record<string, (params: unknown) => unknown>): string[] {
  const methods: string[] = [];
  fetchMock.mockImplementation(async (url, init) => {
    // Only JSON-RPC POSTs are routed; bodiless requests (garaga fetching its own
    // WASM binary) fall through to the real fetch.
    if (init?.body === undefined) return realFetch(url as RequestInfo, init);
    const body = JSON.parse(String(init.body)) as { id: number; method: string; params?: unknown };
    methods.push(body.method);
    const handler = handlers[body.method];
    if (!handler) throw new Error(`unmocked JSON-RPC method: ${body.method}`);
    const outcome = handler(body.params);
    const payload =
      outcome instanceof JsonRpcError
        ? { error: { code: outcome.code, message: outcome.message } }
        : { result: outcome };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...payload }));
  });
  return methods;
}

// ─── The verifying mock SNIP-29 upstream ───

const NODE_URL = "http://starknet-node.localhost";
const PAYMASTER_URL = "http://paymaster.localhost";
const CLASS_HASH = resolveDeployClassHash({ chainId: CHAIN_IDS.sepolia });
const ACCOUNT = deriveSolAccountAddress(LOCKED_PUBKEY, CLASS_HASH);
/** The fixed felt the upstream returns once (and only once) a signature verifies. */
const TX_HASH = "0xe2e";

const TARGET = "0x5678";
const CALLS: Call[] = [{ contractAddress: TARGET, entrypoint: "transfer", calldata: ["0xcafe"] }];
/** A realistic validity window a live paymaster would issue (1h), not the fixed
 *  (0, 3600) locked-vector window of core's signer.test.ts. */
const EXECUTION_WINDOW_SECS = 3600;
/** The gas token + fee sink used by the "default" fee-mode journey. */
const GAS_TOKEN = "0xfee";
const GAS_SINK = "0x5179";

/** u256 limbs → the 32 little-endian bytes they encode. */
function u256LimbsToLeBytes(low: bigint, high: bigint): Uint8Array {
  let n = low | (high << 128n);
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return bytes;
}

/** SNIP-29 wire shape of a call inside paymaster_buildTransaction. */
type WireCall = { to: string; selector: string; calldata: string[] };
type WireOutsideCall = { To: string; Selector: string; Calldata: string[] };
type BuildRequest = {
  transaction: {
    type: string;
    deployment?: Record<string, unknown>;
    invoke: { user_address: string; calls: WireCall[] };
  };
  parameters: { version: string; fee_mode: unknown };
};
type ExecuteRequest = {
  transaction: {
    type: string;
    deployment?: Record<string, unknown>;
    invoke: { user_address: string; typed_data: TypedData; signature: string[] };
  };
  parameters: { version: string; fee_mode: unknown };
};

const PAYMASTER_FEE = {
  gas_token_price_in_strk: "0x0",
  estimated_fee_in_strk: "0x0",
  estimated_fee_in_gas_token: "0x0",
  suggested_max_fee_in_strk: "0x0",
  suggested_max_fee_in_gas_token: "0x0",
};

/** Real SNIP-9 v2 typed data for the requested wire calls, via starknet.js's own
 *  helper. The Calls entries are spliced in from the wire request because the
 *  helper's Call → OutsideCallV2 mapping needs entrypoint NAMES, and the wire
 *  carries them pre-hashed as selectors. */
function issueTypedData(wireCalls: WireCall[], nonce: string): TypedData {
  const skeleton = outsideExecution.getTypedData(
    CHAIN_IDS.sepolia,
    {
      caller: constants.OutsideExecutionCallerAny,
      execute_after: 0,
      execute_before: Math.floor(Date.now() / 1000) + EXECUTION_WINDOW_SECS,
    },
    nonce,
    [],
    OutsideExecutionVersion.V2,
  );
  return {
    ...skeleton,
    message: {
      ...skeleton.message,
      Calls: wireCalls.map((c) => ({ To: c.to, Selector: c.selector, Calldata: c.calldata })),
    },
  };
}

interface MockUpstream {
  /** Ordered log of every JSON-RPC method that hit the wire. */
  methods: string[];
  /** Every paymaster_buildTransaction request body, verbatim. */
  builds: BuildRequest[];
  /** Every paymaster_executeTransaction request body, verbatim. */
  executes: ExecuteRequest[];
  /** The typed data issued per build (what the wallet is expected to sign). */
  issued: TypedData[];
  /** How many signatures passed the full cryptographic verification. */
  verifications: number;
  /** Chain state behind starknet_getClassHashAt; flips to true after a
   *  successful (verified) sponsored deploy-and-invoke. */
  deployed: boolean;
}

/** THE VERIFIER — the point of this suite. Parses the garaga felt bundle the SDK
 *  submitted as the signature and rejects (loudly) anything a real verifying
 *  paymaster + sol_account would reject:
 *    felts[0..3]  Ry.low/high, s.low/high — the 64-byte Ed25519 signature,
 *                 each half the LE bytes of a u256 (mapping proven against the
 *                 locked-vector felts in core's garaga.test.ts);
 *    felts[4..]   msg_len, then the message bytes: the ASCII text
 *                 "0x"+64-hex of getMessageHash(issued typed data, account).
 *  The v1 bundle carries no public key (the account verifies against its stored
 *  signer), so signer binding is proven by the real Ed25519 verification in step 3. */
function verifySponsoredSignature(request: ExecuteRequest, upstream: MockUpstream): void {
  const issued = upstream.issued[upstream.issued.length - 1];
  if (!issued) {
    throw new Error("mock upstream: paymaster_executeTransaction before any buildTransaction");
  }
  const { user_address, signature } = request.transaction.invoke;
  // 1. Parse the garaga felt bundle.
  const felts = signature.map(BigInt);
  const msgLen = Number(felts[4] ?? -1n);
  if (msgLen <= 0 || felts.length < 5 + msgLen) {
    throw new Error(`mock upstream: signature is not a garaga felt bundle (${felts.length} felts)`);
  }
  // 2. Message binding: the signed bytes must be the base64 (no label) of the SNIP-12
  //    hash of the typed data THIS upstream issued, bound to the requesting account's
  //    address - the exact message form sol_account base64-decodes and checks.
  const msgBytes = Uint8Array.from(felts.slice(5, 5 + msgLen), (felt) => Number(felt));
  const signedText = new TextDecoder().decode(msgBytes);
  const messageHash = BigInt(snip12.getMessageHash(issued, user_address));
  const expectedText = feltToBase64Hash("0x" + messageHash.toString(16));
  if (signedText !== expectedText) {
    throw new Error(
      `mock upstream: wallet signed "${signedText}" but the issued typed data hashes ` +
        `to "${expectedText}" for account ${user_address}`,
    );
  }
  // 2b. Bind the SUBMITTED typed_data (what a real paymaster actually executes and
  //     verifies against) to that same hash — an SDK that signed one document but
  //     submitted another (stale/substituted) would sail past step 2 otherwise.
  const submittedHash = BigInt(
    snip12.getMessageHash(request.transaction.invoke.typed_data, user_address),
  );
  if (submittedHash !== messageHash) {
    throw new Error("mock upstream: submitted typed_data does not hash to the signed message");
  }
  // 3. Reconstruct the 64-byte Ed25519 signature (R ‖ s) and verify it for real,
  //    against the connected wallet's key - the v1 structural signer binding.
  const sig64 = new Uint8Array(64);
  sig64.set(u256LimbsToLeBytes(felts[0], felts[1]), 0);
  sig64.set(u256LimbsToLeBytes(felts[2], felts[3]), 32);
  if (!ed25519Verify(null, msgBytes, walletPublicKey, sig64)) {
    throw new Error("mock upstream: Ed25519 verification of the reconstructed signature failed");
  }
  upstream.verifications += 1;
}

/** Wire up the Starknet node + verifying SNIP-29 paymaster behind fetch. */
function installUpstream(
  opts: {
    deployed?: boolean;
    /** Tamper hook for the confused-deputy scenario: mutate the calls the
     *  upstream builds typed data for (a malicious/compromised paymaster). */
    tamperCalls?: (calls: WireCall[]) => WireCall[];
    /** Refuse every build with this JSON-RPC error (sponsorship rejected). */
    buildError?: JsonRpcError;
    /** "default" fee mode: append a gas-token `transfer(GAS_SINK, fee)` repayment
     *  call and quote `fee` as suggested_max_fee_in_gas_token (as a real
     *  gas-token paymaster would). */
    gasToken?: { address: string; fee: string };
  } = {},
): MockUpstream {
  const upstream: MockUpstream = {
    methods: [],
    builds: [],
    executes: [],
    issued: [],
    verifications: 0,
    deployed: opts.deployed ?? false,
  };
  let nonce = 0;
  upstream.methods = mockRpc({
    starknet_specVersion: () => "0.9.0",
    starknet_chainId: () => CHAIN_IDS.sepolia,
    starknet_getClassHashAt: () =>
      upstream.deployed ? CLASS_HASH : new JsonRpcError(20, "Contract not found"),
    // The post-deploy waiter (memoized for concurrent calls) polls in the
    // background; resolve it immediately.
    starknet_getTransactionStatus: () => ({
      finality_status: "ACCEPTED_ON_L2",
      execution_status: "SUCCEEDED",
    }),
    starknet_getTransactionReceipt: () => ({
      type: "INVOKE",
      transaction_hash: TX_HASH,
      actual_fee: { amount: "0x0", unit: "FRI" },
      execution_status: "SUCCEEDED",
      finality_status: "ACCEPTED_ON_L2",
      block_hash: "0x1",
      block_number: 1,
      messages_sent: [],
      events: [],
      execution_resources: { l1_gas: 0, l1_data_gas: 0, l2_gas: 0 },
    }),
    paymaster_buildTransaction: (params) => {
      const request = params as BuildRequest;
      upstream.builds.push(request);
      if (opts.buildError) return opts.buildError;
      let calls = opts.tamperCalls?.(request.transaction.invoke.calls) ?? [
        ...request.transaction.invoke.calls,
      ];
      let fee = PAYMASTER_FEE;
      if (opts.gasToken) {
        // transfer(recipient, amount: u256) → [recipient, amount_low, amount_high].
        calls = [
          ...calls,
          {
            to: opts.gasToken.address,
            selector: hash.getSelectorFromName("transfer"),
            calldata: [GAS_SINK, opts.gasToken.fee, "0x0"],
          },
        ];
        fee = { ...PAYMASTER_FEE, suggested_max_fee_in_gas_token: opts.gasToken.fee };
      }
      const typed_data = issueTypedData(calls, "0x" + (++nonce).toString(16));
      upstream.issued.push(typed_data);
      const parameters = { version: "0x1", fee_mode: request.parameters.fee_mode };
      const deployment = request.transaction.deployment;
      return deployment
        ? { type: "deploy_and_invoke", deployment, typed_data, parameters, fee }
        : { type: "invoke", typed_data, parameters, fee };
    },
    paymaster_executeTransaction: (params) => {
      const request = params as ExecuteRequest;
      upstream.executes.push(request);
      verifySponsoredSignature(request, upstream); // throws with a precise reason
      if (request.transaction.type === "deploy_and_invoke") upstream.deployed = true;
      return { transaction_hash: TX_HASH, tracking_id: "0x1" };
    },
  });
  return upstream;
}

// ─── The dapp journey ───

/** Exactly what a dapp does: construct the connector, connect, take the account. */
async function connectedAccount(
  paymaster: PaymasterConfig = { nodeUrl: PAYMASTER_URL },
): Promise<SolanaAsStarknetAccount> {
  const connector = new PhantomConnector({
    starknetRpcUrl: NODE_URL,
    chainId: CHAIN_IDS.sepolia,
    paymaster,
  });
  await connector.connect();
  return (await connector.account()) as SolanaAsStarknetAccount;
}

beforeEach(() => {
  installPhantom();
});

afterEach(() => {
  fetchMock.mockReset();
  delete (globalThis as { window?: unknown }).window;
});

describe("sponsored execution e2e (verifying mock SNIP-29 upstream)", () => {
  it("sponsors an undeployed account's first execute as a verified deploy-and-invoke", async () => {
    const upstream = installUpstream();
    const account = await connectedAccount();

    const res = await account.execute(CALLS);

    expect(res.transaction_hash).toBe(TX_HASH);
    // Exactly one build and one execute hit the upstream — and the execute only
    // returned TX_HASH because the full cryptographic verification passed.
    expect(upstream.builds).toHaveLength(1);
    expect(upstream.executes).toHaveLength(1);
    expect(upstream.verifications).toBe(1);
    // The build request bundled OUR counterfactual deployment, straight from the
    // account's derivation (SNIP-29 deploymentData).
    expect(upstream.builds[0].transaction.type).toBe("deploy_and_invoke");
    expect(upstream.builds[0].transaction.deployment).toEqual({
      address: account.derivation.address,
      class_hash: CLASS_HASH,
      salt: account.derivation.salt,
      calldata: account.derivation.calldata,
      version: 1,
    });
    expect(account.derivation.address).toBe(ACCOUNT.address);
    // What was signed and executed is exactly the requested call — nothing else.
    const executed = upstream.executes[0].transaction;
    expect(executed.type).toBe("deploy_and_invoke");
    expect(BigInt(executed.invoke.user_address)).toBe(BigInt(ACCOUNT.address));
    const signedCalls = (executed.invoke.typed_data.message as { Calls: WireOutsideCall[] }).Calls;
    expect(signedCalls).toHaveLength(1);
    expect(BigInt(signedCalls[0].To)).toBe(BigInt(TARGET));
    expect(BigInt(signedCalls[0].Selector)).toBe(BigInt(hash.getSelectorFromName("transfer")));
    expect(signedCalls[0].Calldata.map((felt) => BigInt(felt))).toEqual([0xcafen]);
  });

  it("builds a plain invoke — no deployment field — once the account is deployed", async () => {
    const upstream = installUpstream();
    // First session deploys through the sponsored deploy-and-invoke journey…
    await (await connectedAccount()).execute(CALLS);
    expect(upstream.deployed).toBe(true);
    // …and a returning session (fresh connector, same wallet) now probes an
    // on-chain class hash, so its build request must carry no deployment.
    const res = await (await connectedAccount()).execute(CALLS);

    expect(res.transaction_hash).toBe(TX_HASH);
    expect(upstream.builds).toHaveLength(2);
    expect(upstream.builds[1].transaction.type).toBe("invoke");
    expect(upstream.builds[1].transaction).not.toHaveProperty("deployment");
    expect(upstream.verifications).toBe(2);
  });

  it("rejects upstream-tampered calldata before signing; nothing reaches execution", async () => {
    const { signMessage } = installPhantom(); // capture the wallet-sign spy
    const upstream = installUpstream({
      deployed: true,
      // The confused deputy: same call, one mutated felt in the calldata.
      tamperCalls: (calls) => calls.map((c) => ({ ...c, calldata: ["0xbad"] })),
    });
    const account = await connectedAccount();

    await expect(account.execute(CALLS)).rejects.toThrow(/does not match the requested call/);
    expect(upstream.methods).not.toContain("paymaster_executeTransaction");
    expect(upstream.verifications).toBe(0);
    // The rejection fired BEFORE signing: the wallet's signMessage was never invoked
    // (upstream.verifications==0 alone can't prove this — signing is local).
    expect(signMessage).not.toHaveBeenCalled();
  });

  it("propagates a build refusal as-is, executing nothing else", async () => {
    const upstream = installUpstream({
      deployed: true,
      buildError: new JsonRpcError(155, "transaction sponsoring refused"),
    });
    const account = await connectedAccount();

    await expect(account.execute(CALLS)).rejects.toThrow(/sponsoring refused/);
    expect(upstream.methods).not.toContain("paymaster_executeTransaction");
    expect(upstream.methods).not.toContain("starknet_estimateFee");
    expect(upstream.methods).not.toContain("starknet_addInvokeTransaction");
  });

  it("requests sponsored fee mode on the wire by default", async () => {
    const upstream = installUpstream({ deployed: true });
    await (await connectedAccount()).execute(CALLS);

    expect(upstream.builds[0].parameters).toEqual({
      version: "0x1",
      fee_mode: { mode: "sponsored" },
    });
  });

  it("default fee mode: signs and verifies a gas-token-bounded repayment end-to-end", async () => {
    // A real gas-token paymaster appends transfer(fee sink, quoted fee) and quotes
    // that same fee; the SDK guard binds the amount to the quote (≤ our ceiling).
    const upstream = installUpstream({
      deployed: true,
      gasToken: { address: GAS_TOKEN, fee: "0x64" }, // 100
    });
    const account = await connectedAccount({
      nodeUrl: PAYMASTER_URL,
      feeMode: { mode: "default", gasToken: GAS_TOKEN, maxFeeInGasToken: 100n },
    });

    const res = await account.execute(CALLS);

    expect(res.transaction_hash).toBe(TX_HASH);
    expect(upstream.verifications).toBe(1); // full crypto verification still passed
    // The SDK sent SNIP-29's gas-token fee mode on the wire (no caller ceiling leaks).
    expect(upstream.builds[0].parameters).toEqual({
      version: "0x1",
      fee_mode: { mode: "default", gas_token: GAS_TOKEN },
    });
    // The signed+submitted bundle is the requested call PLUS the bounded repayment.
    const signedCalls = (
      upstream.executes[0].transaction.invoke.typed_data.message as {
        Calls: WireOutsideCall[];
      }
    ).Calls;
    expect(signedCalls).toHaveLength(2);
    expect(BigInt(signedCalls[0].To)).toBe(BigInt(TARGET));
    expect(BigInt(signedCalls[1].To)).toBe(BigInt(GAS_TOKEN));
    expect(BigInt(signedCalls[1].Selector)).toBe(BigInt(hash.getSelectorFromName("transfer")));
    expect(BigInt(signedCalls[1].Calldata[1])).toBe(0x64n); // amount == the quoted fee
  });

  it("default fee mode: rejects an over-ceiling gas-token repayment before signing", async () => {
    // Quote (and pull) 101 in gas token against a configured max of 100.
    const upstream = installUpstream({
      deployed: true,
      gasToken: { address: GAS_TOKEN, fee: "0x65" }, // 101 > 100
    });
    const account = await connectedAccount({
      nodeUrl: PAYMASTER_URL,
      feeMode: { mode: "default", gasToken: GAS_TOKEN, maxFeeInGasToken: 100n },
    });

    await expect(account.execute(CALLS)).rejects.toThrow(/exceeds the configured maxFeeInGasToken/);
    expect(upstream.methods).not.toContain("paymaster_executeTransaction");
    expect(upstream.verifications).toBe(0);
  });
});
