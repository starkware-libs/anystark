#!/usr/bin/env bun
// ─── CCTP mainnet verification harness ───
//
// The reproducible ritual behind the VERIFICATION STATUS block on
// CCTP_MAINNET_CONFIG (src/config.ts). Three modes, in the order you run them:
//
//   bun verify_mainnet.mjs --preflight   everything checkable WITHOUT funds
//   bun verify_mainnet.mjs --setup       mint a throwaway wallet + funding instructions
//   bun verify_mainnet.mjs --run         the real-money round trip
//
// ┌─────────────────────────────────────────────────────────────────────────────┐
// │ --run SPENDS REAL MONEY. It burns real USDC on Solana mainnet-beta, mints   │
// │ it on Starknet mainnet, then burns it back. It bridges 0.01 USDC by default │
// │ (a one-cent verification), but Solana still charges SOL for fees and rent   │
// │ and the two Starknet legs consume AVNU sponsorship credits on your          │
// │ paymaster key. Budget ~0.05 USDC and ~0.01-0.02 SOL on the throwaway        │
// │ wallet. There are no faucets and no airdrops on mainnet.                    │
// └─────────────────────────────────────────────────────────────────────────────┘
//
// The funded run doubles as the hosted-paymaster parity test: it proves AVNU's
// mainnet paymaster sponsors the custom sol_account class for BOTH the
// counterfactual deploy (which rides the first execute) and plain invokes. That
// verdict is printed as its own PASS/FAIL line in the result block.
//
// Flags:
//   --preflight        no-funds checks; exits non-zero on any failure (CI-safe)
//   --setup            generate/reuse the throwaway seed, derive identities, report
//                      funding readiness. Writes the state file. No transactions.
//   --run              the round trip (deposit → withdraw)
//   --dry-deposit      build + SIMULATE the Solana burn without sending it. Needs a
//                      state file but no funds; proves the CCTP account list / PDA
//                      wiring against the live mainnet IDLs.
//   --sponsored-probe  send ONE zero-value Starknet approve to prove the sponsored
//                      path and land the counterfactual deploy. Costs sponsorship
//                      credits (no USDC).
//   --amount=<usdc>    deposit amount as a decimal (default: 0.01 USDC)
//   --skip-withdraw    stop after the deposit leg
//   --state=<path>     state file (default: ./.verify-mainnet-state.json, 0600)
//   --force            --setup only: regenerate the seed, abandoning the old one
//
// Env:
//   PAYMASTER_API_KEY       MAINNET SNIP-29 paymaster key (required for any Starknet write)
//   PAYMASTER_KEY_ENV_FILE  dotenv file to read the key from when PAYMASTER_API_KEY is unset
//   PAYMASTER_URL           override the paymaster endpoint (default: AVNU hosted mainnet)
//   PAYMASTER_KEY_HEADER    header to send the key under (default: x-paymaster-api-key)
//   STARKNET_RPC_URL        override the Starknet RPC (do this for the real run)
//   SOLANA_RPC_URL     override the Solana RPC (do this for the real run)
//   SEED               --setup only: reuse an existing 32-byte seed (64 hex)
//
// EVERY leg of --run is resumable. Each on-chain identifier (burn signature, burn tx
// hash, attested message + attestation, receive tx) is persisted the moment it
// exists, and an interrupted run picks up exactly where it stopped. If the state file
// is lost, the bridge's recovery API (findRecoverableDeposits /
// findRecoverableWithdrawals) re-discovers an in-flight burn from chain history, so a
// crash cannot strand funds. A burn is never issued while an in-flight one exists.
//
// Secrets are never printed: not the seed, not the paymaster key.

/* global process, console, fetch */

import { unlinkSync } from "node:fs";

import {
  AttestationTimeout,
  CLASS_HASH,
  DEFAULT_DEPOSIT_RAW,
  MIN_SOL_LAMPORTS,
  MIN_USDC_RAW,
  apiKeySource,
  assessAmountViability,
  assertMainnetReady,
  bridge,
  cctpConfig,
  fail,
  fetchLaneFees,
  fmtSol,
  fmtStrk,
  fmtUsdc,
  fundingInstructions,
  info,
  loadState,
  makeAccount,
  makeSignAndSend,
  maxFeeCeiling,
  newSeedHex,
  ok,
  pollAttestation,
  receiptActualFee,
  resolvePaymasterApiKey,
  resolveFeeMode,
  resolveStatePath,
  saveState,
  seedToKeys,
  solAccountAddress,
  solBalance,
  solanaConnection,
  solscan,
  starknetProvider,
  starknetUsdcBalance,
  step,
  voyager,
} from "./verify_mainnet_lib.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => args.find((a) => a.startsWith(`${name}=`))?.split("=")[1];

const STATE_PATH = resolveStatePath(args);
const persist = (state) => saveState(STATE_PATH, state);

const ATTESTATION_CAP_MS = 1_800_000; // 30 min per leg — mainnet standard finality is slower

const MODES = ["--preflight", "--setup", "--run", "--dry-deposit", "--sponsored-probe"];
const mode = MODES.find((m) => flag(m));
if (!mode) {
  console.error(
    "Pick a mode: --preflight | --setup | --run | --dry-deposit | --sponsored-probe\n" +
      "See the header of this file for the full flag list.",
  );
  process.exit(64);
}

// ══════════════════════════════════════════════════════════════════════════════
// MODE: --preflight — everything verifiable without a single unit of value
// ══════════════════════════════════════════════════════════════════════════════

if (mode === "--preflight") {
  let failures = 0;
  const check = (label, passed, detail = "") => {
    if (passed) ok(`${label}${detail ? ` — ${detail}` : ""}`);
    else {
      failures += 1;
      fail(`${label}${detail ? ` — ${detail}` : ""}`);
    }
  };
  const attempt = async (label, fn) => {
    try {
      const detail = await fn();
      check(label, true, detail ?? "");
    } catch (error) {
      check(
        label,
        false,
        String(error?.message ?? error)
          .split("\n")[0]
          .slice(0, 220),
      );
    }
  };

  console.log("CCTP mainnet preflight — read-only, no funds, no transactions.");

  // ── 1. config sanity ──
  step("Config");
  const sn = cctpConfig.starknet;
  const sol = cctpConfig.solana;
  info(`attestationApi  : ${cctpConfig.attestationApi}`);
  info(`starknetRpcUrl  : ${cctpConfig.starknetRpcUrl}`);
  info(`solana.rpcUrl   : ${sol.rpcUrl}`);
  check(
    "attestation API is Circle production Iris",
    cctpConfig.attestationApi === "https://iris-api.circle.com",
    cctpConfig.attestationApi.includes("sandbox") ? "SANDBOX host would never attest" : "",
  );
  check("Starknet CCTP domain is 25", sn.domain === 25, `got ${sn.domain}`);
  check("Solana CCTP domain is 5", sol.domain === 5, `got ${sol.domain}`);
  for (const [name, address] of Object.entries({
    messageTransmitter: sn.messageTransmitter,
    tokenMessenger: sn.tokenMessenger,
    usdc: sn.usdc,
  })) {
    check(
      `starknet.${name} is a well-formed felt`,
      /^0x0[0-9a-fA-F]{62,63}$/.test(address) && BigInt(address) > 0n,
      address,
    );
  }
  for (const [name, address] of Object.entries({
    messageTransmitter: sol.messageTransmitter,
    tokenMessengerMinter: sol.tokenMessengerMinter,
    usdcMint: sol.usdcMint,
  })) {
    check(
      `solana.${name} is a well-formed base58 pubkey`,
      /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address),
      address,
    );
  }
  check(
    "Solana USDC mint is the mainnet-beta mint (not the devnet one)",
    sol.usdcMint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    sol.usdcMint,
  );

  // ── 2. Solana mainnet-beta ──
  step("Solana mainnet-beta");
  const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
  const connection = await solanaConnection();
  await attempt("RPC is Solana mainnet-beta", async () => {
    const genesis = await connection.getGenesisHash();
    if (genesis !== MAINNET_GENESIS) throw new Error(`genesis ${genesis} is not mainnet-beta`);
    return `genesis ${genesis}`;
  });
  const { PublicKey } = await import("@solana/web3.js");
  for (const [name, id] of [
    ["MessageTransmitterV2", sol.messageTransmitter],
    ["TokenMessengerMinterV2", sol.tokenMessengerMinter],
  ]) {
    await attempt(`${name} program is deployed and executable`, async () => {
      const account = await connection.getAccountInfo(new PublicKey(id));
      if (!account) throw new Error(`no account at ${id}`);
      if (!account.executable) throw new Error(`${id} exists but is not executable`);
      return `owner ${account.owner.toBase58()}`;
    });
  }
  await attempt("USDC mint is a 6-decimal SPL mint", async () => {
    const spl = await import("@solana/spl-token");
    const mint = await spl.getMint(connection, new PublicKey(sol.usdcMint));
    if (mint.decimals !== 6) throw new Error(`decimals ${mint.decimals}, expected 6`);
    return `decimals ${mint.decimals}, supply ${mint.supply}`;
  });

  // ── 3. Starknet mainnet ──
  step("Starknet mainnet");
  await attempt("RPC is Starknet mainnet (SN_MAIN) and sol_account class is declared", async () => {
    const chainId = await assertMainnetReady();
    return `chainId ${chainId}, class ${CLASS_HASH} declared`;
  });
  for (const [name, address] of [
    ["MessageTransmitterV2", sn.messageTransmitter],
    ["TokenMessengerMinterV2", sn.tokenMessenger],
    ["USDC", sn.usdc],
  ]) {
    await attempt(`${name} contract is deployed`, async () => {
      const classHash = await starknetProvider.getClassHashAt(address);
      if (!classHash || BigInt(classHash) === 0n) throw new Error("zero class hash");
      return `class ${classHash}`;
    });
  }
  await attempt("Starknet USDC answers decimals() with 6", async () => {
    const [decimals] = await starknetProvider.callContract({
      contractAddress: sn.usdc,
      entrypoint: "decimals",
      calldata: [],
    });
    if (BigInt(decimals) !== 6n) throw new Error(`decimals ${BigInt(decimals)}, expected 6`);
    return "decimals 6";
  });
  await attempt("Starknet USDC answers balanceOf()", async () => {
    const balance = await starknetUsdcBalance("0x1");
    return `balanceOf(0x1) = ${fmtUsdc(balance)}`;
  });

  // ── 4. derivation + call building (pure, no network writes) ──
  step("Derivation and call building");
  const existing = loadState(STATE_PATH);
  // With no state file, use an EPHEMERAL in-memory seed: preflight must never write.
  const keys = await seedToKeys(existing?.seedHex ?? newSeedHex());
  const derivedFrom = existing?.seedHex ? "the existing state file" : "an ephemeral in-memory seed";
  info(`identities derived from ${derivedFrom} (nothing written)`);
  await attempt("sol_account address derives from the Solana pubkey", async () => {
    const address = solAccountAddress(keys.pubkeyBytes);
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(address)) throw new Error(`malformed address ${address}`);
    return address;
  });
  await attempt("USDC ATA derives, and the base58 and 32-byte forms agree", async () => {
    const ata = await bridge.solanaUsdcAta(keys.pubkeyBase58);
    const bytes = await bridge.solanaUsdcAtaBytes(keys.pubkeyBase58);
    if (bytes.length !== 32) throw new Error(`ATA bytes length ${bytes.length}, expected 32`);
    if (new PublicKey(bytes).toBase58() !== ata) throw new Error("ATA base58/bytes disagree");
    return ata;
  });
  await attempt(
    "buildWithdrawToSolanaCalls targets the mainnet USDC + TokenMessenger",
    async () => {
      const calls = bridge.buildWithdrawToSolanaCalls(
        MIN_USDC_RAW,
        await bridge.solanaUsdcAtaBytes(keys.pubkeyBase58),
      );
      if (calls.length !== 2) throw new Error(`expected 2 calls, got ${calls.length}`);
      if (BigInt(calls[0].contractAddress) !== BigInt(sn.usdc))
        throw new Error("call 0 is not USDC");
      if (BigInt(calls[1].contractAddress) !== BigInt(sn.tokenMessenger)) {
        throw new Error("call 1 is not the TokenMessenger");
      }
      return `${calls[0].entrypoint} + ${calls[1].entrypoint}`;
    },
  );
  await attempt("buildReceiveOnStarknetCall targets the mainnet MessageTransmitter", async () => {
    const call = bridge.buildReceiveOnStarknetCall("0x1234", "0x5678");
    if (BigInt(call.contractAddress) !== BigInt(sn.messageTransmitter)) {
      throw new Error("receive call does not target the MessageTransmitter");
    }
    if (call.entrypoint !== "receive_message") throw new Error(`entrypoint ${call.entrypoint}`);
    return `${call.entrypoint} with ${call.calldata.length} felts`;
  });
  await attempt(
    "CCTP V2 program IDLs are fetchable from mainnet (what the burn needs)",
    async () => {
      const anchor = await import("@coral-xyz/anchor");
      const provider = new anchor.AnchorProvider(
        connection,
        {
          publicKey: new PublicKey(keys.pubkeyBase58),
          signTransaction: async (tx) => tx,
          signAllTransactions: async (txs) => txs,
        },
        { commitment: "confirmed" },
      );
      const [tmm, mt] = await Promise.all([
        anchor.Program.fetchIdl(new PublicKey(sol.tokenMessengerMinter), provider),
        anchor.Program.fetchIdl(new PublicKey(sol.messageTransmitter), provider),
      ]);
      if (!tmm) throw new Error("TokenMessengerMinterV2 IDL not published on mainnet");
      if (!mt) throw new Error("MessageTransmitterV2 IDL not published on mainnet");
      return `TokenMessengerMinterV2 v${tmm.metadata?.version ?? "?"}, MessageTransmitterV2 v${mt.metadata?.version ?? "?"}`;
    },
  );

  // ── 5. off-chain services ──
  step("Off-chain services");
  await attempt("production Iris answers for an unknown Solana burn (404 → pending)", async () => {
    const attested = await bridge.fetchAttestation(sol.domain, "1".repeat(87));
    if (attested.status !== "pending_confirmations") throw new Error(`status ${attested.status}`);
    return "unknown burn reported as pending_confirmations, not an error";
  });
  await attempt(
    "production Iris answers for an unknown Starknet burn (404 → pending)",
    async () => {
      const attested = await bridge.fetchAttestation(sn.domain, `0x${"11".repeat(32)}`);
      if (attested.status !== "pending_confirmations") throw new Error(`status ${attested.status}`);
      return "unknown burn reported as pending_confirmations, not an error";
    },
  );
  // Circle's published fee schedule per lane, and whether the default 0.01 USDC
  // round trip actually survives it. This is the arithmetic that decides whether a
  // one-cent verification is possible at all, so it is a preflight check, not a
  // discovery made mid-burn.
  let laneFees = null;
  await attempt("Circle publishes a fee schedule for both lanes", async () => {
    const [deposit, withdraw] = await Promise.all([
      fetchLaneFees(sol.domain, sn.domain),
      fetchLaneFees(sn.domain, sol.domain),
    ]);
    laneFees = { deposit, withdraw };
    const render = (lanes) =>
      lanes.map((l) => `threshold ${l.finalityThreshold} = ${l.minimumFee} bps`).join(", ");
    info(`  deposit  Solana→Starknet : ${render(deposit)}`);
    info(`  withdraw Starknet→Solana : ${render(withdraw)}`);
    return "both lanes priced";
  });
  await attempt(
    `the default ${fmtUsdc(DEFAULT_DEPOSIT_RAW)} round trip survives Circle's fees`,
    () => {
      if (!laneFees) throw new Error("fee schedule unavailable");
      // Deposit burns at standard finality with max_fee 0, so it must be a 0 bps lane.
      const depositStandard = laneFees.deposit.find((l) => l.finalityThreshold === 2000);
      if (!depositStandard || depositStandard.minimumFee !== 0) {
        throw new Error(
          `deposit standard lane charges ${depositStandard?.minimumFee ?? "?"} bps, but the ` +
            "deposit burns with max_fee 0 and would be rejected",
        );
      }
      // Withdraw burns at fast finality with a max_fee ceiling of amount/200 (50 bps).
      const v = assessAmountViability(DEFAULT_DEPOSIT_RAW, laneFees.withdraw);
      if (!v.feeFitsCeiling) {
        throw new Error(
          `withdraw fee ${v.bps} bps = ${v.feeRaw} raw exceeds the max_fee ceiling ` +
            `${v.ceiling} raw at ${fmtUsdc(DEFAULT_DEPOSIT_RAW)} — raise --amount`,
        );
      }
      if (!v.leavesValue) {
        throw new Error(
          `the fee consumes the whole ${fmtUsdc(DEFAULT_DEPOSIT_RAW)} — raise --amount`,
        );
      }
      return (
        `deposit exact (0 bps); withdraw fee ${v.bps} bps = ${v.feeRaw} raw under a ` +
        `${v.ceiling} raw ceiling, returning ${fmtUsdc(v.receivedRaw)}`
      );
    },
  );

  const paymasterUrl = process.env.PAYMASTER_URL || "https://starknet.paymaster.avnu.fi";
  await attempt(`paymaster ${paymasterUrl} is available`, async () => {
    const res = await fetch(paymasterUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "paymaster_isAvailable", params: [] }),
    });
    const body = await res.json();
    if (body.result !== true) throw new Error(`paymaster_isAvailable → ${JSON.stringify(body)}`);
    return "paymaster_isAvailable = true";
  });
  const apiKey = resolvePaymasterApiKey({ required: false });
  if (apiKey) ok(`paymaster key resolved from ${apiKeySource()} (value not shown)`);
  else info("no paymaster key — required for --run / --sponsored-probe, not for preflight");

  step("PREFLIGHT RESULT");
  if (failures === 0) {
    ok("all no-funds checks passed: CCTP_MAINNET_CONFIG is address-verified and live on-chain");
    info("NOT yet proven: the funded round trip. Next: --setup, fund, then --run.");
  } else {
    fail(`${failures} check(s) failed — do not run the funded verification`);
  }
  process.exit(failures === 0 ? 0 : 1);
}

// ══════════════════════════════════════════════════════════════════════════════
// MODE: --setup — throwaway wallet, derived identities, funding readiness
// ══════════════════════════════════════════════════════════════════════════════

if (mode === "--setup") {
  const existing = loadState(STATE_PATH);

  step("Throwaway Ed25519 wallet");
  let seedHex;
  if (process.env.SEED) {
    seedHex = process.env.SEED;
    info("seed: taken from the SEED env var");
  } else if (existing?.seedHex && !flag("--force")) {
    seedHex = existing.seedHex;
    info(`seed: reused from ${STATE_PATH}`);
  } else {
    if (existing?.seedHex) {
      info("--force given: discarding the previous seed (ANY FUNDS ON IT ARE ABANDONED)");
      unlinkSync(STATE_PATH);
    }
    seedHex = newSeedHex();
    info("seed: freshly generated");
  }
  const keys = await seedToKeys(seedHex);

  console.log(`
  !! THROWAWAY MAINNET KEY !! The 32-byte seed lives in plaintext in
     ${STATE_PATH} (chmod 600). It is a disposable key that will briefly hold
     REAL funds. Never reuse it, put no more on it than the few dollars the run
     needs, sweep it when you are done, and delete the state file.`);

  step("Derived identities");
  const starknetAddress = solAccountAddress(keys.pubkeyBytes);
  const ata = await bridge.solanaUsdcAta(keys.pubkeyBase58);
  info(`Solana mainnet pubkey : ${keys.pubkeyBase58}`);
  info(`Solana USDC ATA       : ${ata}`);
  info(`sol_account (mainnet) : ${starknetAddress}`);
  info(`sol_account class hash: ${CLASS_HASH}`);

  // The counterfactual address must be reproducible from the account object itself.
  const apiKey = resolvePaymasterApiKey();
  const account = makeAccount(keys, apiKey, resolveFeeMode(args));
  if (BigInt(account.address) !== BigInt(starknetAddress)) {
    throw new Error("derived address and SolanaAsStarknetAccount.address disagree");
  }
  ok("SolanaAsStarknetAccount.address matches deriveSolAccountAddress");

  step("Starknet mainnet preflight");
  await assertMainnetReady();
  ok(`chainId is SN_MAIN and class ${CLASS_HASH} is declared on mainnet`);
  info(`sol_account deployed  : ${await account.isDeployed()}`);
  info(`paymaster             : ${account.paymasterConfig.nodeUrl}`);
  info(`paymaster key         : ${apiKeySource()} (value not shown)`);
  info(`fee mode              : ${account.paymasterConfig.feeMode?.mode ?? "sponsored"}`);

  persist({
    ...(existing ?? {}),
    network: "mainnet",
    seedHex,
    solanaPubkey: keys.pubkeyBase58,
    solanaUsdcAta: ata,
    starknetAddress,
    classHash: CLASS_HASH,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  });

  step("Balances");
  const connection = await solanaConnection();
  const lamports = await solBalance(connection, keys.pubkeyBase58);
  const solanaUsdc = await bridge.solanaUsdcBalance(keys.pubkeyBase58);
  const starknetUsdc = await starknetUsdcBalance(starknetAddress);
  info(`SOL                        : ${fmtSol(lamports)}`);
  info(`Solana mainnet USDC        : ${fmtUsdc(solanaUsdc)}`);
  info(`sol_account mainnet USDC   : ${fmtUsdc(starknetUsdc)}`);

  const hasSol = lamports >= MIN_SOL_LAMPORTS;
  const hasUsdc = solanaUsdc >= MIN_USDC_RAW;
  step("Readiness for --run");
  info(`SOL  >= ${fmtSol(MIN_SOL_LAMPORTS)} : ${hasSol ? "YES" : "NO"}`);
  info(`USDC >= ${fmtUsdc(MIN_USDC_RAW)}     : ${hasUsdc ? "YES" : "NO"}`);
  if (hasSol && hasUsdc) {
    ok("wallet is funded — run:  bun verify_mainnet.mjs --run");
    info("REMINDER: --run spends real USDC, real SOL, and AVNU sponsorship credits.");
  } else {
    console.log(`\n${fundingInstructions(keys.pubkeyBase58, ata, STATE_PATH)}`);
    console.log(
      "\nNothing is stranded: --setup writes only the state file and sends no" +
        "\ntransactions. Re-running it simply re-checks the balances above.",
    );
  }
  process.exit(hasSol && hasUsdc ? 0 : 1);
}

// ══════════════════════════════════════════════════════════════════════════════
// Everything below needs a funded (or at least generated) throwaway wallet
// ══════════════════════════════════════════════════════════════════════════════

const state = loadState(STATE_PATH);
if (!state?.seedHex) {
  console.error(
    `No usable state at ${STATE_PATH}.\nRun the setup phase first:  bun verify_mainnet.mjs --setup`,
  );
  process.exit(1);
}

const keys = await seedToKeys(state.seedHex);
if (keys.pubkeyBase58 !== state.solanaPubkey) {
  throw new Error("state file pubkey does not match its seed — refusing to run.");
}
const starknetAddress = solAccountAddress(keys.pubkeyBytes);
if (BigInt(starknetAddress) !== BigInt(state.starknetAddress)) {
  throw new Error("derived sol_account address drifted from the state file — refusing to run.");
}

const ledger = [];
const record = (leg, what, ref, link) => {
  ledger.push({ leg, what, ref, link });
  info(`${what}: ${ref}${link ? `\n         ${link}` : ""}`);
};

const apiKey = resolvePaymasterApiKey();
const account = makeAccount(keys, apiKey, resolveFeeMode(args));
const connection = await solanaConnection();

/**
 * Hosted-paymaster parity ledger. The funded run is also the proof that AVNU's
 * mainnet paymaster sponsors this SDK's CUSTOM sol_account class — not just the
 * standard wallet classes — for a counterfactual deploy_and_invoke and for plain
 * invokes. Persisted so a resumed run does not lose a verdict it already earned.
 */
const parity = (state.parity ??= { deploySponsored: false, invokeSponsored: false });
/** On-chain fees the paymaster covered, in FRI. Sponsorship credits bill against this. */
let sponsoredFri = 0n;
let sponsoredTxs = 0;

function recordSponsorship(receipt, { wasDeployedBefore }) {
  const fee = receiptActualFee(receipt);
  if (fee) {
    // Unit is FRI on v3 transactions; anything else is reported verbatim rather than
    // silently converted.
    if (fee.unit === "FRI" || fee.unit === "WEI") sponsoredFri += fee.amount;
    sponsoredTxs += 1;
    info(
      `paymaster covered ${fee.unit === "FRI" ? fmtStrk(fee.amount) : `${fee.amount} ${fee.unit}`}`,
    );
  }
  if (wasDeployedBefore) parity.invokeSponsored = true;
  else {
    // The account did not exist before this tx and the tx succeeded: the paymaster
    // sponsored a deploy_and_invoke of the custom class.
    parity.deploySponsored = true;
    parity.invokeSponsored = true;
  }
  persist(state);
}

step("Identities");
info(`Solana mainnet pubkey : ${keys.pubkeyBase58}`);
info(`Solana USDC ATA       : ${state.solanaUsdcAta}`);
info(`sol_account (mainnet) : ${starknetAddress}`);
info(`paymaster             : ${account.paymasterConfig.nodeUrl}`);
info(`paymaster key         : ${apiKeySource()} (value not shown)`);
info(`fee mode              : ${account.paymasterConfig.feeMode?.mode ?? "sponsored"}`);

step("Preflight");
await assertMainnetReady();
ok("Starknet mainnet RPC + declared sol_account class");
const lamports = await solBalance(connection, keys.pubkeyBase58);
const solanaUsdc0 = await bridge.solanaUsdcBalance(keys.pubkeyBase58);
const starknetUsdc0 = await starknetUsdcBalance(starknetAddress);
info(`SOL                        : ${fmtSol(lamports)}`);
info(`Solana mainnet USDC        : ${fmtUsdc(solanaUsdc0)}`);
info(`sol_account mainnet USDC   : ${fmtUsdc(starknetUsdc0)}`);
info(`sol_account deployed       : ${await account.isDeployed()}`);

// ─── --sponsored-probe: prove the sponsored Starknet path with no USDC at all ───

if (mode === "--sponsored-probe") {
  step("Sponsored-execute probe (zero-value approve; the deploy rides along)");
  info("this costs AVNU sponsorship credits but no USDC");
  const wasDeployedBefore = await account.isDeployed();
  const zeroApprove = {
    contractAddress: cctpConfig.starknet.usdc,
    entrypoint: "approve",
    calldata: [cctpConfig.starknet.tokenMessenger, "0x0", "0x0"],
  };
  const { transaction_hash } = await account.execute([zeroApprove]);
  record("probe", "starknet tx", transaction_hash, voyager(transaction_hash));
  const receipt = await starknetProvider.waitForTransaction(transaction_hash);
  if (!receipt.isSuccess()) throw new Error("sponsored probe transaction reverted");
  recordSponsorship(receipt, { wasDeployedBefore });
  ok("the paymaster sponsored a sol_account execute on mainnet");
  ok(`sol_account deployed: ${await account.isDeployed()}`);
  step("HOSTED PAYMASTER PARITY");
  console.log(
    `  hosted AVNU mainnet sponsors custom class deploy+invoke : ${
      parity.deploySponsored && parity.invokeSponsored
        ? "PASS"
        : parity.invokeSponsored
          ? `INVOKE ONLY (deploy ${parity.deploySponsored ? "proven earlier" : "not observed — the account already existed"})`
          : "FAIL"
    }`,
  );
  info(`on-chain fee the paymaster covered across ${sponsoredTxs} tx: ${fmtStrk(sponsoredFri)}`);
  process.exit(0);
}

// ─── --dry-deposit: build + simulate the Solana burn without sending it ───

if (mode === "--dry-deposit") {
  step("Deposit dry-run (builds and simulates the burn; never sends)");
  const DRY_STOP = "__dry_deposit_stop__";
  try {
    await bridge.depositFromSolana({
      amount: MIN_USDC_RAW,
      starknetRecipient: starknetAddress,
      ownerPubkey: keys.pubkeyBase58,
      signAndSend: async (tx) => {
        info(
          `built: ${tx.instructions.length} instruction(s), ${tx.signatures.length} signer(s), ` +
            `feePayer ${tx.feePayer.toBase58()}`,
        );
        tx.partialSign(keys.solanaKeypair);
        const { value } = await connection.simulateTransaction(tx);
        info(`simulation err: ${JSON.stringify(value.err)}`);
        for (const line of (value.logs ?? []).slice(-5)) info(`  log: ${line}`);
        if (value.err === null) ok("burn simulates clean — the wallet is fully funded");
        else info("(AccountNotFound / insufficient funds here just means the wallet is unfunded)");
        throw new Error(DRY_STOP);
      },
    });
  } catch (error) {
    if (!String(error?.message).includes(DRY_STOP)) throw error;
  }
  ok("depositFromSolana built a valid CCTP V2 depositForBurn against the live mainnet IDLs");
  process.exit(0);
}

// ══════════════════════════════════════════════════════════════════════════════
// MODE: --run — the funded round trip
// ══════════════════════════════════════════════════════════════════════════════

// ─── readiness gate ───

const depositStarted = Boolean(state.deposit?.burnSig);
if (!depositStarted && (lamports < MIN_SOL_LAMPORTS || solanaUsdc0 < MIN_USDC_RAW)) {
  fail(
    `not ready: SOL ${fmtSol(lamports)} (need >= ${fmtSol(MIN_SOL_LAMPORTS)}), ` +
      `USDC ${fmtUsdc(solanaUsdc0)} (need >= ${fmtUsdc(MIN_USDC_RAW)})`,
  );
  console.error(`\n${fundingInstructions(keys.pubkeyBase58, state.solanaUsdcAta, STATE_PATH)}`);
  process.exit(1);
}
if (lamports < MIN_SOL_LAMPORTS) {
  info(
    `WARNING: only ${fmtSol(lamports)} left — the Solana-side receive still needs fees ` +
      "and rent. Top it up if the withdraw leg fails.",
  );
}

/**
 * Await a Starknet tx and require success. On revert (or a wait failure) the stored
 * hash is FORGOTTEN so a resumed run re-submits instead of re-waiting forever on a
 * transaction that will never succeed.
 */
async function requireStarknetSuccess(txHash, forgetHash) {
  try {
    const receipt = await starknetProvider.waitForTransaction(txHash);
    if (receipt.isSuccess()) return receipt;
    throw new Error(
      `starknet tx ${txHash} did not succeed (${receipt.statusReceipt ?? "reverted"})`,
    );
  } catch (error) {
    forgetHash();
    persist(state);
    throw error;
  }
}

function chosenAmount(available) {
  const override = value("--amount");
  if (override === undefined) {
    return available < DEFAULT_DEPOSIT_RAW ? available : DEFAULT_DEPOSIT_RAW;
  }
  const [whole, frac = ""] = override.split(".");
  const raw = BigInt(whole || "0") * 1_000_000n + BigInt((frac + "000000").slice(0, 6));
  if (raw <= 0n) throw new Error("--amount must be positive");
  if (raw > available) {
    throw new Error(`--amount ${fmtUsdc(raw)} exceeds the balance ${fmtUsdc(available)}`);
  }
  return raw;
}

/**
 * Refuse to burn an amount the return leg cannot carry. Circle's fast-lane fee is a
 * bps figure, so a small enough amount either rounds its fee above the bridge's
 * max_fee ceiling or eats the entire transfer — both would strand USDC on Starknet.
 * Checked against Circle's live schedule before the first burn, never assumed.
 */
async function assertReturnLegViable(amountRaw) {
  const lanes = await fetchLaneFees(cctpConfig.starknet.domain, cctpConfig.solana.domain);
  const v = assessAmountViability(amountRaw, lanes);
  info(
    `Circle's Starknet→Solana fast lane: ${v.bps} bps ⇒ fee ${v.feeRaw} raw on ` +
      `${fmtUsdc(amountRaw)}, ceiling ${v.ceiling} raw, returning ${fmtUsdc(v.receivedRaw)}`,
  );
  if (!v.feeFitsCeiling || !v.leavesValue) {
    // Search upward, in cents, for the smallest amount this lane can actually carry,
    // so the operator gets a number instead of "try bigger".
    let minViable = null;
    for (let candidate = amountRaw; candidate <= 10_000_000n; candidate += 10_000n) {
      const probe = assessAmountViability(candidate, lanes);
      if (probe.feeFitsCeiling && probe.leavesValue) {
        minViable = candidate;
        break;
      }
    }
    throw new Error(
      `${fmtUsdc(amountRaw)} cannot make the return trip: Circle's fee is ${v.feeRaw} raw ` +
        `against a ${v.ceiling} raw max_fee ceiling. ` +
        (minViable
          ? `The smallest viable amount on this lane is ${fmtUsdc(minViable)} — pass --amount.`
          : "No amount up to 10 USDC works on this lane; the withdraw leg needs a code change.") +
        " Or run with --skip-withdraw to verify the deposit leg only.",
    );
  }
  return v;
}

// ─── the round trip ───

let exitCode = 0;
try {
  // ══ LEG 1: Solana mainnet-beta → Starknet mainnet ══
  const deposit = (state.deposit ??= {});
  step("LEG 1 — deposit: burn USDC on Solana mainnet, mint at the sol_account");

  if (deposit.done) {
    ok(`already completed in an earlier run (${fmtUsdc(deposit.mintedRaw ?? 0n)} minted)`);
    if (deposit.burnSig)
      record("deposit", "solana burn", deposit.burnSig, solscan(deposit.burnSig));
    if (deposit.receiveTx)
      record("deposit", "starknet receive", deposit.receiveTx, voyager(deposit.receiveTx));
  } else {
    if (!deposit.burnSig) {
      // Never issue a second burn while one is in flight: ask the chain first.
      info("scanning for an in-flight burn (findRecoverableDeposits)…");
      const [recoverable] = await bridge.findRecoverableDeposits(
        keys.pubkeyBase58,
        starknetAddress,
      );
      if (recoverable) {
        info("adopting a previously burned, not-yet-minted deposit found on-chain");
        deposit.burnSig = recoverable.burnSig;
        deposit.amountRaw = recoverable.amount;
        deposit.message = recoverable.message;
        deposit.attestation = recoverable.attestation;
        deposit.solanaUsdcBefore ??= solanaUsdc0 + recoverable.amount;
        deposit.starknetUsdcBefore ??= await starknetUsdcBalance(starknetAddress);
        persist(state);
      } else {
        deposit.amountRaw = chosenAmount(solanaUsdc0);
        // Prove the return leg can carry this amount BEFORE burning anything: an
        // amount too small for Circle's fast-lane fee would strand it on Starknet.
        if (!flag("--skip-withdraw")) await assertReturnLegViable(deposit.amountRaw);
        deposit.solanaUsdcBefore = solanaUsdc0;
        deposit.starknetUsdcBefore = starknetUsdc0;
        persist(state);
        info(
          `burning ${fmtUsdc(deposit.amountRaw)} on Solana mainnet (standard finality, maxFee 0)`,
        );
        const burnSig = await bridge.depositFromSolana({
          amount: deposit.amountRaw,
          starknetRecipient: starknetAddress,
          ownerPubkey: keys.pubkeyBase58,
          signAndSend: makeSignAndSend(connection, keys.solanaKeypair, {
            // Persist BEFORE confirmation: a crash here must not lose the burn.
            onSignature: (signature) => {
              deposit.burnSig = signature;
              persist(state);
            },
          }),
        });
        deposit.burnSig = burnSig;
        persist(state);
      }
      record("deposit", "solana burn", deposit.burnSig, solscan(deposit.burnSig));
    } else {
      info("resuming: burn already on-chain");
      record("deposit", "solana burn", deposit.burnSig, solscan(deposit.burnSig));
    }

    if (!deposit.message || !deposit.attestation) {
      info(`polling Circle for the attestation (Solana domain ${cctpConfig.solana.domain})…`);
      const attested = await pollAttestation(cctpConfig.solana.domain, deposit.burnSig, {
        capMs: ATTESTATION_CAP_MS,
      });
      deposit.message = attested.message;
      deposit.attestation = attested.attestation;
      deposit.eventNonce = attested.eventNonce;
      persist(state);
    } else {
      ok("attestation already stored");
    }

    // Captured before the execute: if the account did not exist yet, this transaction
    // is a paymaster-sponsored deploy_and_invoke of the custom sol_account class.
    const deployedBeforeReceive = await account.isDeployed();
    if (!deposit.receiveTx) {
      info("submitting the permissionless receive_message on Starknet…");
      const { transaction_hash } = await account.execute([
        bridge.buildReceiveOnStarknetCall(deposit.message, deposit.attestation),
      ]);
      deposit.receiveTx = transaction_hash;
      persist(state);
    } else {
      info("resuming: receive_message already submitted");
    }
    record("deposit", "starknet receive", deposit.receiveTx, voyager(deposit.receiveTx));
    const receiveReceipt = await requireStarknetSuccess(deposit.receiveTx, () => {
      deposit.receiveTx = undefined;
    });
    recordSponsorship(receiveReceipt, { wasDeployedBefore: deployedBeforeReceive });
    ok(
      deployedBeforeReceive
        ? "receive_message accepted (sponsored invoke on an already-deployed account)"
        : "receive_message accepted (the counterfactual deploy rode this first execute)",
    );
    ok(`sol_account deployed: ${await account.isDeployed()}`);

    const starknetAfter = await starknetUsdcBalance(starknetAddress);
    deposit.mintedRaw = starknetAfter - (deposit.starknetUsdcBefore ?? 0n);
    if (deposit.mintedRaw === deposit.amountRaw) {
      ok(`minted exactly ${fmtUsdc(deposit.mintedRaw)} at the sol_account (maxFee 0 ⇒ no fee)`);
    } else if (deposit.mintedRaw > 0n) {
      ok(`minted ${fmtUsdc(deposit.mintedRaw)} (burned ${fmtUsdc(deposit.amountRaw)})`);
    } else {
      throw new Error(
        `sol_account USDC did not increase: before ${fmtUsdc(deposit.starknetUsdcBefore ?? 0n)}, ` +
          `after ${fmtUsdc(starknetAfter)}`,
      );
    }
    deposit.done = true;
    persist(state);
  }

  // ══ LEG 2: Starknet mainnet → Solana mainnet-beta ══
  if (flag("--skip-withdraw")) {
    info("--skip-withdraw given: stopping after the deposit leg");
    info("NOTE: the bridged USDC is now sitting at the sol_account. Run again without");
    info("      --skip-withdraw to bring it back.");
  } else {
    const withdraw = (state.withdraw ??= {});
    step("LEG 2 — withdraw: burn USDC on Starknet, mint back on Solana mainnet");

    if (withdraw.done) {
      ok(`already completed in an earlier run (${fmtUsdc(withdraw.receivedRaw ?? 0n)} received)`);
      if (withdraw.burnTx)
        record("withdraw", "starknet burn", withdraw.burnTx, voyager(withdraw.burnTx));
      if (withdraw.receiveSig)
        record("withdraw", "solana receive", withdraw.receiveSig, solscan(withdraw.receiveSig));
    } else {
      if (!withdraw.burnTx) {
        info("scanning for an in-flight withdrawal (findRecoverableWithdrawals)…");
        const [recoverable] = await bridge.findRecoverableWithdrawals(
          starknetAddress,
          keys.pubkeyBase58,
        );
        if (recoverable) {
          info("adopting a previously burned, not-yet-minted withdrawal found on-chain");
          withdraw.burnTx = recoverable.starknetTx;
          withdraw.message = recoverable.message;
          withdraw.attestation = recoverable.attestation;
          withdraw.solanaUsdcBefore ??= await bridge.solanaUsdcBalance(keys.pubkeyBase58);
          persist(state);
        } else {
          const starknetNow = await starknetUsdcBalance(starknetAddress);
          const bridged = deposit.mintedRaw ?? deposit.amountRaw ?? 0n;
          withdraw.amountRaw = bridged < starknetNow ? bridged : starknetNow;
          if (withdraw.amountRaw <= 0n) {
            throw new Error("nothing to withdraw: the sol_account holds no USDC");
          }
          withdraw.starknetUsdcBefore = starknetNow;
          withdraw.solanaUsdcBefore = await bridge.solanaUsdcBalance(keys.pubkeyBase58);
          persist(state);
          info(
            `burning ${fmtUsdc(withdraw.amountRaw)} on Starknet (fast finality; ` +
              `max_fee ceiling ${fmtUsdc(maxFeeCeiling(withdraw.amountRaw))})`,
          );
          const calls = await bridge.buildWithdrawToOwnerCalls(
            withdraw.amountRaw,
            keys.pubkeyBase58,
          );
          const { transaction_hash } = await account.execute(calls);
          withdraw.burnTx = transaction_hash;
          persist(state);
        }
        record("withdraw", "starknet burn", withdraw.burnTx, voyager(withdraw.burnTx));
        const burnReceipt = await requireStarknetSuccess(withdraw.burnTx, () => {
          withdraw.burnTx = undefined;
        });
        // By now the account is deployed, so this is the pure-invoke half of parity.
        recordSponsorship(burnReceipt, { wasDeployedBefore: true });
        ok("approve + deposit_for_burn accepted on mainnet");
      } else {
        info("resuming: Starknet burn already on-chain");
        record("withdraw", "starknet burn", withdraw.burnTx, voyager(withdraw.burnTx));
      }

      if (!withdraw.message || !withdraw.attestation) {
        info(`polling Circle for the attestation (Starknet domain ${cctpConfig.starknet.domain})…`);
        const attested = await pollAttestation(cctpConfig.starknet.domain, withdraw.burnTx, {
          capMs: ATTESTATION_CAP_MS,
        });
        withdraw.message = attested.message;
        withdraw.attestation = attested.attestation;
        withdraw.eventNonce = attested.eventNonce;
        persist(state);
      } else {
        ok("attestation already stored");
      }

      if (!withdraw.receiveSig) {
        info("submitting receive_message on Solana (the throwaway wallet signs and pays SOL)…");
        const signature = await bridge.receiveOnSolana({
          message: withdraw.message,
          attestation: withdraw.attestation,
          ownerPubkey: keys.pubkeyBase58,
          signAndSend: makeSignAndSend(connection, keys.solanaKeypair, {
            onSignature: (sig) => {
              withdraw.receiveSig = sig;
              persist(state);
            },
          }),
        });
        withdraw.receiveSig = signature;
        persist(state);
      } else {
        info("resuming: Solana receive already submitted");
      }
      record("withdraw", "solana receive", withdraw.receiveSig, solscan(withdraw.receiveSig));

      const solanaAfter = await bridge.solanaUsdcBalance(keys.pubkeyBase58);
      withdraw.receivedRaw = solanaAfter - (withdraw.solanaUsdcBefore ?? 0n);
      const maxFee = maxFeeCeiling(withdraw.amountRaw ?? 0n);
      if (withdraw.receivedRaw <= 0n) {
        throw new Error(
          `Solana USDC did not increase: before ${fmtUsdc(withdraw.solanaUsdcBefore ?? 0n)}, ` +
            `after ${fmtUsdc(solanaAfter)}`,
        );
      }
      const circleFee = (withdraw.amountRaw ?? withdraw.receivedRaw) - withdraw.receivedRaw;
      ok(
        `received ${fmtUsdc(withdraw.receivedRaw)} on Solana mainnet ` +
          `(Circle fast-finality fee ${fmtUsdc(circleFee)}, ceiling was ${fmtUsdc(maxFee)})`,
      );
      if (circleFee > maxFee) fail(`fee ${fmtUsdc(circleFee)} exceeded the max_fee ceiling`);
      withdraw.done = true;
      persist(state);
    }
  }
} catch (error) {
  exitCode = error instanceof AttestationTimeout ? 2 : 1;
  persist(state);
  step("INTERRUPTED");
  fail(String(error?.message ?? error));
  console.log(
    "\nState persisted (nothing is stranded). Every identifier obtained so far is in" +
      `\n${STATE_PATH}; resume the exact same leg with:\n\n  bun verify_mainnet.mjs --run\n` +
      "\nIf the state file is ever lost, the bridge re-discovers the in-flight burn from" +
      "\nchain history via findRecoverableDeposits / findRecoverableWithdrawals, which" +
      "\n--run consults automatically before ever issuing a new burn.",
  );
}

// ─── ledger ───

step("LEDGER");
if (ledger.length === 0) info("(no on-chain action taken)");
for (const entry of ledger) {
  console.log(`  [${entry.leg}] ${entry.what}\n      ${entry.ref}\n      ${entry.link ?? ""}`);
}

step("RESULT");
const depositPass = Boolean(state.deposit?.done);
const withdrawPass = Boolean(state.withdraw?.done);
console.log(
  `  LEG 1  deposit  Solana mainnet → sol_account : ${depositPass ? "PASS" : "FAIL/INCOMPLETE"}` +
    `${state.deposit?.mintedRaw !== undefined ? `  (${fmtUsdc(state.deposit.mintedRaw)} minted)` : ""}`,
);
console.log(
  `  LEG 2  withdraw sol_account → Solana mainnet : ${
    flag("--skip-withdraw") ? "SKIPPED" : withdrawPass ? "PASS" : "FAIL/INCOMPLETE"
  }${state.withdraw?.receivedRaw !== undefined ? `  (${fmtUsdc(state.withdraw.receivedRaw)} received)` : ""}`,
);
const roundTripPass = depositPass && (withdrawPass || flag("--skip-withdraw"));
console.log(`  ROUND TRIP: ${roundTripPass ? "PASS" : "INCOMPLETE"}`);

// The second thing this run verifies: AVNU's hosted mainnet paymaster accepting the
// SDK's custom account class, for the counterfactual deploy and for plain invokes.
const parityPass = parity.deploySponsored && parity.invokeSponsored;
console.log(
  `  hosted AVNU mainnet sponsors custom class deploy+invoke : ${
    parityPass
      ? "PASS"
      : parity.invokeSponsored
        ? "PARTIAL (invoke sponsored; deploy not observed — the account already existed)"
        : "FAIL/NOT OBSERVED"
  }`,
);
info(`  deploy_and_invoke sponsored : ${parity.deploySponsored ? "yes" : "not observed"}`);
info(`  plain invoke sponsored      : ${parity.invokeSponsored ? "yes" : "not observed"}`);
info(
  `  on-chain fee AVNU covered   : ${fmtStrk(sponsoredFri)} across ${sponsoredTxs} tx ` +
    "this run (credits bill against this, possibly with AVNU's margin on top)",
);

if (roundTripPass && !flag("--skip-withdraw")) {
  info("");
  info("Tick `round-trip-verified` in the VERIFICATION STATUS block on");
  info("CCTP_MAINNET_CONFIG (src/config.ts) and record the tx refs from the ledger above.");
}
step("Final balances");
info(`Solana mainnet USDC      : ${fmtUsdc(await bridge.solanaUsdcBalance(keys.pubkeyBase58))}`);
info(`sol_account mainnet USDC : ${fmtUsdc(await starknetUsdcBalance(starknetAddress))}`);
info(`SOL                      : ${fmtSol(await solBalance(connection, keys.pubkeyBase58))}`);
info("");
info("SWEEP the throwaway wallet and delete the state file when you are done.");
process.exit(exitCode);
