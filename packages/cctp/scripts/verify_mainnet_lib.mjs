// Shared plumbing for the mainnet CCTP verification harness (verify_mainnet.mjs).
//
// RUNTIME: bun. The workspace packages export TypeScript source from their
// package.json "exports", so plain `node` cannot import them by package name.
//
// REAL MONEY: everything here points at Starknet mainnet, Solana mainnet-beta, and
// Circle's production attestation API. There are no faucets and no airdrops on
// these networks; a mistake costs real USDC and real SOL.
//
// Nothing in this module touches the network at import time — every function takes
// its connection / keys as arguments. Secrets (the throwaway Ed25519 seed, the
// paymaster API key) are NEVER logged: only public keys and addresses are printed.

/* global process, console, Buffer, setTimeout, fetch */

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createPrivateKey, createPublicKey, randomBytes, sign as ed25519Sign } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RpcProvider } from "starknet";
import { CCTP_MAINNET_CONFIG, CctpBridge } from "@starkware-libs/anystark-cctp";
import {
  CHAIN_IDS,
  SolanaAsStarknetAccount,
  deriveSolAccountAddress,
  resolveDeployClassHash,
} from "@starkware-libs/anystark-core";

export const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Default state file. Dot-prefixed and .gitignore'd: it holds the throwaway seed in
 * the clear. Override with --state=<path> to keep several runs side by side.
 */
export const DEFAULT_STATE_PATH = join(HERE, ".verify-mainnet-state.json");

export function resolveStatePath(argv = process.argv.slice(2)) {
  const override = argv.find((a) => a.startsWith("--state="))?.slice("--state=".length);
  return override ? resolve(override) : DEFAULT_STATE_PATH;
}

// PKCS8 DER prefix that wraps a raw 32-byte Ed25519 seed into an importable private
// key. Mirrors packages/react/src/sepolia.e2e.helpers.ts (seedToKeypair) — this
// harness deliberately reuses that suite's "no browser Phantom" signing approach.
const ED25519_PKCS8_PREFIX = "302e020100300506032b657004220420";

/**
 * Minimum SOL the Solana legs need: the burn transaction fee, rent for the
 * ephemeral messageSentEventData account, rent for the used-nonce account the
 * Solana-side receive creates, and ATA rent if the wallet has never held USDC.
 * 0.01 SOL is comfortable for all of it on mainnet.
 */
export const MIN_SOL_LAMPORTS = 10_000_000n; // 0.01 SOL
export const LAMPORTS_PER_SOL = 1_000_000_000n;

/**
 * Default amount the round trip bridges: 0.01 USDC. A one-cent verification is
 * deliberate — the point is to prove the wiring, not to move value.
 *
 * It survives both legs' fee math (see assessAmountViability): the deposit burns at
 * standard finality with max_fee 0 (Circle charges 0 bps there, so the mint is
 * exact), and the withdraw burns at fast finality where the bridge's max_fee
 * ceiling is amount/200 = 50 bps, comfortably above Circle's published 12 bps
 * minimum on the Starknet→Solana lane. At 10_000 raw units that is a 50-unit
 * ceiling against a 12-unit fee: no underflow, no zero-fee ceiling.
 */
export const DEFAULT_DEPOSIT_RAW = 10_000n; // 0.01 USDC
/** Readiness gate: the wallet must hold at least what the run will bridge. */
export const MIN_USDC_RAW = DEFAULT_DEPOSIT_RAW;
/** Mirrors MAX_FEE_BPS in src/bridge.ts — the withdraw leg's max_fee is amount/200. */
export const MAX_FEE_DIVISOR = 200n;

/**
 * Header the paymaster expects the API key under. Defaults to x-paymaster-api-key (what
 * AVNU's hosted paymaster and the anystark paymaster-proxy use); set PAYMASTER_KEY_HEADER
 * for a SNIP-29 paymaster that authenticates under a different header.
 */
export const PAYMASTER_KEY_HEADER =
  process.env.PAYMASTER_KEY_HEADER?.trim() || "x-paymaster-api-key";
/** Default paymaster endpoint (AVNU's hosted SNIP-29 mainnet); override with PAYMASTER_URL. */
export const DEFAULT_PAYMASTER_URL = "https://starknet.paymaster.avnu.fi";

// ─── config ───

/**
 * CCTP_MAINNET_CONFIG with RPC overrides. The public endpoints in the shipped
 * config are fine for a smoke test but are rate-limited; point STARKNET_RPC_URL /
 * SOLANA_RPC_URL at your own nodes for the real run.
 */
export const cctpConfig = {
  ...CCTP_MAINNET_CONFIG,
  starknetRpcUrl: process.env.STARKNET_RPC_URL || CCTP_MAINNET_CONFIG.starknetRpcUrl,
  solana: {
    ...CCTP_MAINNET_CONFIG.solana,
    rpcUrl: process.env.SOLANA_RPC_URL || CCTP_MAINNET_CONFIG.solana.rpcUrl,
  },
};

export const bridge = new CctpBridge(cctpConfig);
export const starknetProvider = new RpcProvider({ nodeUrl: cctpConfig.starknetRpcUrl });

/**
 * Resolve the paymaster API key. Never printed, never persisted. Any SNIP-29 paymaster
 * works; mainnet keys are typically self-serve (no allowlist) but draw on prepaid
 * credits, so a run spends both USDC and credits.
 *
 * Preference order: PAYMASTER_API_KEY in the environment, then a PAYMASTER_API_KEY line in
 * the dotenv file named by PAYMASTER_KEY_ENV_FILE (an untracked developer file outside this
 * repo, e.g. a consuming dapp's .env.local that already holds a working key), so an operator
 * need not re-export it.
 */
export function resolvePaymasterApiKey({ required = true } = {}) {
  const fromEnv = (process.env.PAYMASTER_API_KEY ?? "").trim();
  if (fromEnv) return fromEnv;
  const dotenvPath = (process.env.PAYMASTER_KEY_ENV_FILE ?? "").trim();
  if (dotenvPath && existsSync(dotenvPath)) {
    const contents = readFileSync(dotenvPath, "utf8");
    const match = contents.match(/^\s*PAYMASTER_API_KEY=(.*)$/m);
    const parsed = (match?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
    if (parsed) return parsed;
  }
  if (!required) return null;
  throw new Error(
    "No paymaster API key. Set PAYMASTER_API_KEY to a MAINNET SNIP-29 paymaster key " +
      "with sponsorship credits (e.g. AVNU: https://paymaster.avnu.fi), or point " +
      "PAYMASTER_KEY_ENV_FILE at a dotenv file containing one. The Starknet side of " +
      "this harness cannot run without one: SolanaAsStarknetAccount always executes " +
      "sponsored, because a Solana-derived account holds no STRK.",
  );
}

/** Where the key came from, for logging. Never includes the key itself. */
export function apiKeySource() {
  if ((process.env.PAYMASTER_API_KEY ?? "").trim()) return "PAYMASTER_API_KEY env var";
  const dotenvPath = (process.env.PAYMASTER_KEY_ENV_FILE ?? "").trim();
  if (dotenvPath && existsSync(dotenvPath)) {
    const contents = readFileSync(dotenvPath, "utf8");
    if (/^\s*PAYMASTER_API_KEY=\S/m.test(contents)) return `PAYMASTER_API_KEY in ${dotenvPath}`;
  }
  return "(unresolved)";
}

/**
 * Fee mode for the Starknet legs.
 *   (default)                     sponsored — AVNU credits pay, the account pays nothing
 *   --fee-mode=default            self-paid — the account repays the paymaster in a gas
 *     --gas-token=<felt>          token, bounded by --max-gas-fee (raw units of that
 *     --max-gas-fee=<raw>         token). Needs that token on the account.
 */
export function resolveFeeMode(argv = process.argv.slice(2)) {
  const arg = (name) =>
    argv
      .find((a) => a.startsWith(`${name}=`))
      ?.split("=")
      .slice(1)
      .join("=");
  if (arg("--fee-mode") !== "default") return { mode: "sponsored" };
  const gasToken = arg("--gas-token");
  const maxFee = arg("--max-gas-fee");
  if (!gasToken || !maxFee) {
    throw new Error("--fee-mode=default requires --gas-token=<felt> and --max-gas-fee=<raw units>");
  }
  return { mode: "default", gasToken, maxFeeInGasToken: BigInt(maxFee) };
}

// ─── keys ───

/**
 * Derive everything from a 32-byte Ed25519 seed (64 hex chars):
 *   - a node:crypto private key (the raw-bytes signer behind the sol_account
 *     signature), the same construction as packages/react/src/sepolia.e2e.helpers.ts;
 *   - the @solana/web3.js Keypair (Solana-side fee payer / burn owner).
 * The two paths are cross-checked: they must produce the identical 32-byte pubkey.
 */
export async function seedToKeys(seedHex) {
  const clean = seedHex.trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error("seed must be exactly 64 hex characters (a 32-byte Ed25519 seed).");
  }
  const seedBytes = Buffer.from(clean, "hex");
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from(ED25519_PKCS8_PREFIX, "hex"), seedBytes]),
    format: "der",
    type: "pkcs8",
  });
  const spkiDer = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const pubkeyBytes = Uint8Array.from(spkiDer.subarray(spkiDer.length - 32));

  const { Keypair } = await import("@solana/web3.js");
  const solanaKeypair = Keypair.fromSeed(seedBytes);
  if (!Buffer.from(solanaKeypair.publicKey.toBytes()).equals(Buffer.from(pubkeyBytes))) {
    throw new Error("internal: node:crypto and @solana/web3.js disagree on the public key");
  }

  return {
    pubkeyBytes,
    pubkeyBase58: solanaKeypair.publicKey.toBase58(),
    solanaKeypair,
    /** SolanaSigner.signBytes — a real Ed25519 signature over the message bytes. */
    signBytes: async (message) => new Uint8Array(ed25519Sign(null, message, privateKey)),
  };
}

export function newSeedHex() {
  return randomBytes(32).toString("hex");
}

// ─── starknet account ───

export const CLASS_HASH = resolveDeployClassHash({ chainId: CHAIN_IDS.mainnet });

/** The counterfactual sol_account address for a raw 32-byte Solana pubkey. */
export function solAccountAddress(pubkeyBytes) {
  return deriveSolAccountAddress(pubkeyBytes, CLASS_HASH).address;
}

/** A SolanaAsStarknetAccount on mainnet backed by the throwaway seed. */
export function makeAccount(keys, apiKey, feeMode = { mode: "sponsored" }) {
  return new SolanaAsStarknetAccount({
    signer: { pubkey: keys.pubkeyBytes, signBytes: keys.signBytes },
    rpcUrl: cctpConfig.starknetRpcUrl,
    classHash: CLASS_HASH,
    paymaster: {
      nodeUrl: process.env.PAYMASTER_URL || DEFAULT_PAYMASTER_URL,
      headers: { [PAYMASTER_KEY_HEADER]: apiKey },
      feeMode,
    },
    signingLabel: "anystark cctp mainnet verification",
  });
}

/**
 * Refuse to run against anything but Starknet mainnet, and require the sol_account
 * class to be declared there — an undeclared class makes every derived address point
 * at nothing, and USDC minted to it would be unreachable.
 */
export async function assertMainnetReady() {
  const chainId = await starknetProvider.getChainId();
  if (chainId !== CHAIN_IDS.mainnet) {
    throw new Error(
      `RPC ${cctpConfig.starknetRpcUrl} reports chainId ${chainId}, not mainnet ` +
        `(${CHAIN_IDS.mainnet}). Refusing to run: this harness is mainnet-only.`,
    );
  }
  try {
    await starknetProvider.getClass(CLASS_HASH);
  } catch {
    throw new Error(
      `sol_account class ${CLASS_HASH} is not declared on Starknet mainnet — every ` +
        "derived address would point at a phantom class and minted USDC would be " +
        "unreachable. Declare it before running this harness.",
    );
  }
  return chainId;
}

/** USDC balance (raw, 6 decimals) of a Starknet address, via a raw balanceOf call. */
export async function starknetUsdcBalance(address) {
  const [low, high] = await starknetProvider.callContract({
    contractAddress: cctpConfig.starknet.usdc,
    entrypoint: "balanceOf",
    calldata: [address],
  });
  return BigInt(low) + (BigInt(high) << 128n);
}

// ─── solana ───

export async function solanaConnection() {
  const { Connection } = await import("@solana/web3.js");
  return new Connection(cctpConfig.solana.rpcUrl, "confirmed");
}

export async function solBalance(connection, pubkeyBase58) {
  const { PublicKey } = await import("@solana/web3.js");
  return BigInt(await connection.getBalance(new PublicKey(pubkeyBase58)));
}

/**
 * The `signAndSend` the bridge expects, backed by a local Keypair instead of Phantom.
 * partialSign (never sign) so the ephemeral messageSentEventData signature that
 * depositFromSolana already attached survives. `onSignature` is awaited BEFORE
 * confirmation so a crash between send and confirm cannot strand the burn.
 */
export function makeSignAndSend(connection, keypair, { onSignature } = {}) {
  return async (tx) => {
    tx.partialSign(keypair);
    const signature = await connection.sendRawTransaction(tx.serialize(), {
      preflightCommitment: "confirmed",
      maxRetries: 5,
    });
    if (onSignature) await onSignature(signature);
    await confirmSolanaSignature(connection, signature);
    return signature;
  };
}

export async function confirmSolanaSignature(connection, signature, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value } = await connection.getSignatureStatus(signature, {
      searchTransactionHistory: true,
    });
    if (value) {
      if (value.err) {
        throw new Error(`solana tx ${signature} failed on-chain: ${JSON.stringify(value.err)}`);
      }
      if (value.confirmationStatus === "confirmed" || value.confirmationStatus === "finalized") {
        return value;
      }
    }
    await sleep(2000);
  }
  throw new Error(`timed out waiting for solana tx ${signature} to confirm`);
}

// ─── attestation polling ───

export class AttestationTimeout extends Error {}

/**
 * Poll Circle until `status === "complete"`, with exponential backoff (4s → 30s) and
 * an overall cap. Throws AttestationTimeout so the caller can persist state and print
 * a resume command instead of losing the burn.
 */
export async function pollAttestation(sourceDomain, burnTxId, { capMs = 1_800_000 } = {}) {
  const deadline = Date.now() + capMs;
  let delay = 4000;
  let lastStatus = "(none)";
  for (let attempt = 1; ; attempt += 1) {
    const attested = await bridge.fetchAttestation(sourceDomain, burnTxId);
    if (attested.status !== lastStatus) {
      lastStatus = attested.status;
      info(`attestation status: ${attested.status}`);
    }
    if (attested.status === "complete" && attested.message && attested.attestation) {
      ok(`attested after ${attempt} poll(s) (eventNonce ${attested.eventNonce ?? "n/a"})`);
      return attested;
    }
    if (Date.now() >= deadline) {
      throw new AttestationTimeout(
        `Circle did not attest burn ${burnTxId} within ${Math.round(capMs / 1000)}s ` +
          `(last status: ${attested.status}).`,
      );
    }
    await sleep(Math.min(delay, Math.max(1000, deadline - Date.now())));
    delay = Math.min(Math.round(delay * 1.4), 30_000);
  }
}

// ─── Circle fee lanes ───

/**
 * Circle's published per-lane fee schedule: one entry per finality threshold, with
 * `minimumFee` in BASIS POINTS of the burned amount. Threshold 2000 (standard) is
 * 0 bps; threshold 1000 (fast) carries a real fee. The deposit leg burns standard,
 * the withdraw leg burns fast, so only the withdraw leg pays.
 */
export async function fetchLaneFees(srcDomain, dstDomain) {
  const url = `${cctpConfig.attestationApi}/v2/burn/USDC/fees/${srcDomain}/${dstDomain}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fee lookup ${srcDomain}→${dstDomain} failed: ${res.status}`);
  return res.json();
}

/** The bridge's max_fee ceiling for an amount — mirrors buildWithdrawToSolanaCalls. */
export function maxFeeCeiling(amountRaw) {
  const computed = amountRaw / MAX_FEE_DIVISOR;
  return computed > 1n ? computed : 1n;
}

/**
 * Prove `amountRaw` survives the withdraw leg: Circle's fast-lane fee, applied at the
 * published bps to this amount, must land strictly inside the bridge's max_fee ceiling
 * AND leave something to receive. Returns a report; throws only on an impossible amount.
 */
export function assessAmountViability(amountRaw, laneFees) {
  const fast = laneFees.find((f) => f.finalityThreshold === 1000);
  const bps = BigInt(fast?.minimumFee ?? 0);
  // Circle charges bps of the amount; round UP, the pessimistic direction for us.
  const feeRaw = (amountRaw * bps + 9_999n) / 10_000n;
  const ceiling = maxFeeCeiling(amountRaw);
  return {
    bps,
    feeRaw,
    ceiling,
    receivedRaw: amountRaw - feeRaw,
    feeFitsCeiling: feeRaw <= ceiling,
    leavesValue: amountRaw - feeRaw > 0n,
  };
}

// ─── sponsorship accounting ───

/**
 * The fee AVNU actually paid on the account's behalf, from a Starknet receipt. This is
 * what a sponsorship credit is billed against (AVNU may add a margin on top, which is
 * not visible on-chain), so it is reported as "on-chain fee AVNU covered", not as the
 * exact credit debit. Returns { amount, unit } or null when the receipt omits it.
 */
export function receiptActualFee(receipt) {
  const actual = receipt?.actual_fee;
  if (actual === undefined || actual === null) return null;
  if (typeof actual === "object") {
    return { amount: BigInt(actual.amount ?? 0), unit: actual.unit ?? "FRI" };
  }
  return { amount: BigInt(actual), unit: "FRI" };
}

/** FRI (1e-18 STRK) → a readable STRK string. */
export function fmtStrk(fri) {
  const whole = fri / 1_000_000_000_000_000_000n;
  const frac = (fri % 1_000_000_000_000_000_000n).toString().padStart(18, "0").slice(0, 9);
  return `${whole}.${frac} STRK`;
}

// ─── state file ───

export function loadState(statePath) {
  if (!existsSync(statePath)) return null;
  return JSON.parse(readFileSync(statePath, "utf8"), (_key, value) =>
    typeof value === "string" && /^\d+n$/.test(value) ? BigInt(value.slice(0, -1)) : value,
  );
}

/** Persist state 0600 — it holds the throwaway seed in the clear. */
export function saveState(statePath, state) {
  const json = JSON.stringify(
    state,
    (_key, value) => (typeof value === "bigint" ? `${value}n` : value),
    2,
  );
  writeFileSync(statePath, `${json}\n`, { mode: 0o600 });
  chmodSync(statePath, 0o600);
}

// ─── formatting / logging ───

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function fmtUsdc(raw) {
  const sign = raw < 0n ? "-" : "";
  const abs = raw < 0n ? -raw : raw;
  return `${sign}${abs / 1_000_000n}.${(abs % 1_000_000n).toString().padStart(6, "0")} USDC`;
}

export function fmtSol(lamports) {
  const whole = lamports / LAMPORTS_PER_SOL;
  return `${whole}.${(lamports % LAMPORTS_PER_SOL).toString().padStart(9, "0")} SOL`;
}

export const step = (text) => console.log(`\n── ${text}`);
export const info = (text) => console.log(`   ${text}`);
export const ok = (text) => console.log(`   PASS  ${text}`);
export const fail = (text) => console.log(`   FAIL  ${text}`);

/** Mainnet explorers — no `?cluster=devnet` query, unlike a testnet run. */
export function solscan(signature) {
  return `https://solscan.io/tx/${signature}`;
}
export function voyager(txHash) {
  return `https://voyager.online/tx/${txHash}`;
}

/**
 * Funding instructions. Mainnet has NO faucet and NO airdrop: the operator must move
 * real SOL and real USDC to the throwaway wallet from a wallet they control.
 */
export function fundingInstructions(pubkeyBase58, ata, statePath) {
  return [
    "FUND THE THROWAWAY WALLET WITH REAL FUNDS, THEN RE-RUN.",
    "",
    "  !! MAINNET !! There is no faucet and no airdrop here. Send from a wallet you",
    "  control, and send only what you are willing to lose.",
    "",
    `  Solana mainnet pubkey : ${pubkeyBase58}`,
    `  its USDC ATA          : ${ata}`,
    "",
    `  (a) SOL for Solana-side fees + rent: ~0.01 SOL minimum, 0.02 SOL comfortable.`,
    `      Send to the WALLET address (${pubkeyBase58}).`,
    "",
    "  (b) USDC: the harness bridges 0.01 USDC by default, so 0.05 USDC covers it.",
    "      Send a little more (1-5 USDC) if you want headroom to repeat the run.",
    `      Send SPL USDC (mint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v) to the`,
    "      WALLET address — your sender creates the ATA. Do not send to the ATA",
    "      address directly unless your tooling requires it.",
    "",
    "  then:  bun verify_mainnet.mjs --setup   # re-check balances (idempotent)",
    "         bun verify_mainnet.mjs --run     # the real-money round trip",
    "",
    `  state file: ${statePath} (chmod 600, holds the seed in plaintext)`,
  ].join("\n");
}
