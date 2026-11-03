// ─── Solana ↔ Starknet CCTP bridge (BETA) ───
// Bidirectional USDC bridge over Circle CCTP V2. No relayer: the browser drives
// the burn, the attestation poll, and the permissionless `receive` on the
// destination chain. Config is injected (see CctpConfig).
//
// BETA: the Solana depositForBurn / receive account-lists + PDA seeds mirror
// Circle's circlefin/solana-cctp-contracts examples and were validated on
// devnet/Sepolia; re-verify against the live programs before mainnet use.
//
// Heavy Solana libs (@solana/web3.js, spl-token, anchor) are imported lazily so
// they stay out of the main bundle.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { CallData, RpcProvider, hash, num, type Call, uint256 } from "starknet";
import type { CctpConfig } from "./config";

// ─── Circle attestation ───

/** Circle attestation statuses we branch on; the `string & {}` keeps autocomplete
 * for the known values while still accepting any other status Circle may return. */
export type AttestationStatus = "pending_confirmations" | "complete" | (string & {});

export interface Attestation {
  status: AttestationStatus;
  /** The CCTP message bytes (hex), present once attested. */
  message: string | null;
  /** Circle's attestation signature (hex), present once `complete`. */
  attestation: string | null;
  /** V2 assigns the nonce at attestation time. */
  eventNonce: string | null;
}

export interface DepositParams {
  /** Raw USDC amount (6 decimals). */
  amount: bigint;
  /** Recipient sol_account address on Starknet (felt hex). */
  starknetRecipient: string;
  /** Phantom signAndSendTransaction (Solana provider). Returns the base58 sig. */
  signAndSend: (tx: unknown) => Promise<string>;
  /** Connected Solana wallet pubkey (base58). */
  ownerPubkey: string;
}

export interface ReceiveOnSolanaParams {
  /** Attested CCTP message bytes (hex). */
  message: string;
  /** Circle attestation signature (hex). */
  attestation: string;
  /** Connected Solana wallet pubkey (base58) — recipient + fee payer. */
  ownerPubkey: string;
  /** Phantom signAndSendTransaction. Returns the base58 sig. */
  signAndSend: (tx: unknown) => Promise<string>;
}

const FINALITY_THRESHOLD_FAST = 0;
const FINALITY_THRESHOLD_STANDARD = 2000;

/** Max CCTP fee the user tolerates on a fast-finality burn: amount / MAX_FEE_BPS (= 0.5%). */
const MAX_FEE_BPS = 200n;
/** Floor so a small (sub-0.0002 USDC) fast-finality burn never sends max_fee=0 and reverts. */
const MIN_MAX_FEE = 1n;

// How far back (in Starknet blocks) the withdraw recovery scans for the
// sol_account's burns. ~1.5M blocks is a generous recent horizon; the chain is
// 10M+ blocks and a full scan would take ~a minute per poll.
const WITHDRAW_SCAN_WINDOW = 1_500_000;

// The generic JSON-RPC invalid-params code. Solana RPCs also use it for a
// missing token account, so classification must match the error message too.
const INVALID_PARAMS_ERROR_CODE = -32602;
// The message Solana RPCs pair with INVALID_PARAMS_ERROR_CODE for a missing
// token account ("Invalid param: could not find account").
const ACCOUNT_NOT_FOUND_MESSAGE_RE = /could not find account/i;

// How far back deposit recovery scans the connected wallet's Solana tx history
// for stuck burns. getSignaturesForAddress returns newest-first, max 1000 per
// page; we paginate with `before` until exhausted or until
// DEPOSIT_SCAN_MAX_SIGNATURES is reached, so a stuck burn sitting behind
// unrelated activity is still discovered instead of being silently dropped at
// the first page. The total cap bounds the scan time for very active wallets.
const DEPOSIT_SCAN_SIGNATURE_PAGE = 1000;
const DEPOSIT_SCAN_MAX_SIGNATURES = 10_000;

// Safety cap on getEvents pages for withdraw discovery (chunk_size 1000 → up to
// WITHDRAW_EVENT_PAGE_LIMIT * 1000 events). The loop normally stops on
// `!continuation_token`; the cap only prevents an unbounded poll. Per-depositor
// filtering keeps real counts far below this.
const WITHDRAW_EVENT_PAGE_LIMIT = 60;

// CCTP V2 BurnMessage byte layout — [start, end) offsets into the message
// bytes, shared by both recovery scanners so the wire format lives in one place.
const MIN_CCTP_MESSAGE_LEN = 248;
const OFFSET_DEST_DOMAIN: [number, number] = [8, 12];
const OFFSET_NONCE: [number, number] = [12, 44];
const OFFSET_MINT_RECIPIENT: [number, number] = [184, 216];
const OFFSET_AMOUNT: [number, number] = [216, 248];

export interface RecoverableDeposit {
  /** Solana burn tx signature. */
  burnSig: string;
  /**
   * Gross burn amount (6 decimals) read from the BurnMessage. Equals the USDC
   * that mints on Starknet only when maxFee==0 — which depositFromSolana
   * enforces — so for transfers this bridge creates it is the minted amount.
   */
  amount: bigint;
  message: string;
  attestation: string;
}

export interface RecoverableWithdraw {
  /** Starknet burn (deposit_for_burn) tx hash. */
  starknetTx: string;
  message: string;
  attestation: string;
}

// ─── pure helpers (config-independent) ───

/** bytes32-as-u256 of a 32-byte Solana address (the recipient's USDC ATA). */
function solanaAddrToU256(recipientAta32: Uint8Array): bigint {
  if (recipientAta32.length !== 32) throw new Error("recipient must be a 32-byte Solana address");
  let n = 0n;
  for (const b of recipientAta32) n = (n << 8n) | BigInt(b); // big-endian bytes32
  return n;
}

/** hex string → Cairo `ByteArray` calldata: [data_len, ...words31, pending, pending_len]. */
function hexToByteArrayCalldata(hex: string): string[] {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes: number[] = [];
  for (let i = 0; i < h.length; i += 2) bytes.push(parseInt(h.slice(i, i + 2), 16));
  const toFelt = (arr: number[]) =>
    "0x" + arr.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n).toString(16);
  const data: string[] = [];
  let i = 0;
  for (; i + 31 <= bytes.length; i += 31) data.push(toFelt(bytes.slice(i, i + 31)));
  const rem = bytes.slice(i);
  return [data.length.toString(), ...data, rem.length ? toFelt(rem) : "0x0", rem.length.toString()];
}

/** hex string → bytes (no 0x). Throws on odd-length or non-hex input. */
function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) throw new Error(`hex string must have even length, got ${h.length}`);
  if (h.length > 0 && !/^[0-9a-fA-F]+$/.test(h))
    throw new Error("hex string contains non-hex characters");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** big-endian bytes → bigint. */
function beToBig(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

/** Fund-critical fields parsed from a CCTP V2 BurnMessage (see OFFSET_* layout). */
export interface CctpMessageFields {
  /** Destination CCTP domain (the mint chain). */
  destDomain: number;
  /** Nonce as a bigint (for the Starknet is_nonce_used check). */
  nonce: bigint;
  /** Raw 32-byte nonce, big-endian (seed for the Solana used_nonce PDA). */
  nonceBytes: Uint8Array;
  /** mint_recipient as bytes32-as-u256 (the destination account / ATA). */
  mintRecipient: bigint;
  /** Gross burn amount (6 decimals). */
  amount: bigint;
}

/**
 * Parse the fund-critical fields from a CCTP V2 BurnMessage's raw bytes using the
 * OFFSET_* layout above. Returns null when the message is shorter than the minimum
 * layout length, so a truncated message can never yield a bogus nonce/amount.
 * Pure and config-independent — unit-tested against a crafted message.
 */
export function parseCctpBurnMessage(bytes: Uint8Array): CctpMessageFields | null {
  if (bytes.length < MIN_CCTP_MESSAGE_LEN) return null;
  return {
    destDomain: Number(beToBig(bytes.subarray(...OFFSET_DEST_DOMAIN))),
    nonce: beToBig(bytes.subarray(...OFFSET_NONCE)),
    nonceBytes: bytes.subarray(...OFFSET_NONCE),
    mintRecipient: beToBig(bytes.subarray(...OFFSET_MINT_RECIPIENT)),
    amount: beToBig(bytes.subarray(...OFFSET_AMOUNT)),
  };
}

/** A felt hex (Starknet address/token) → 32-byte big-endian, for use as a Solana pubkey. */
function feltTo32BE(felt: string): Uint8Array {
  let n = BigInt(felt);
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

/** PublicKey.findProgramAddressSync wrapper with Circle's seed-encoding rules. */
function findPda(PublicKey: any, label: string, programId: any, extraSeeds: any[] = []): any {
  const enc = new TextEncoder();
  const seeds: Uint8Array[] = [enc.encode(label)];
  for (const s of extraSeeds) {
    if (typeof s === "string") seeds.push(enc.encode(s));
    else if (s instanceof Uint8Array) seeds.push(s);
    else seeds.push(s.toBuffer()); // PublicKey
  }
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

/**
 * Bidirectional USDC bridge over Circle CCTP V2, bound to an injected config.
 */
export class CctpBridge {
  constructor(protected readonly config: CctpConfig) {}

  /**
   * Poll Circle's attestation API for a burn, keyed by source domain + burn tx
   * identifier. Returns the latest status; call until `status === "complete"`.
   *
   * The identifier is chain-shaped: the Solana domain keys burns by the base58
   * transaction signature (the value `depositFromSolana` returns); every other
   * domain keys by the 0x hex transaction hash.
   */
  async fetchAttestation(sourceDomain: number, burnTxHash: string): Promise<Attestation> {
    // Input hygiene before URL interpolation. Both accepted alphabets are strictly
    // alphanumeric, so nothing URL-meaningful can pass through. A Solana signature
    // is 64 bytes, which is 86 to 88 base58 characters.
    const expectsBase58 = sourceDomain === this.config.solana.domain;
    const wellFormed = expectsBase58
      ? /^[1-9A-HJ-NP-Za-km-z]{86,88}$/.test(burnTxHash)
      : /^0x[0-9a-fA-F]+$/.test(burnTxHash);
    if (!wellFormed)
      throw new Error(`invalid burn tx ${expectsBase58 ? "signature" : "hash"}: ${burnTxHash}`);
    const url = `${this.config.attestationApi}/v2/messages/${sourceDomain}?transactionHash=${burnTxHash}`;
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 404) {
        return {
          status: "pending_confirmations",
          message: null,
          attestation: null,
          eventNonce: null,
        };
      }
      throw new Error(`attestation fetch failed: ${res.status}`);
    }
    const data = (await res.json()) as {
      messages?: Array<{
        status: string;
        message: string;
        attestation: string;
        eventNonce?: string;
      }>;
    };
    const m = data.messages?.[0];
    if (!m)
      return {
        status: "pending_confirmations",
        message: null,
        attestation: null,
        eventNonce: null,
      };
    return {
      status: m.status,
      message: m.message ?? null,
      attestation: m.attestation ?? null,
      eventNonce: m.eventNonce ?? null,
    };
  }

  /**
   * Build the Starknet calls to burn USDC and bridge it to Solana:
   * approve(tokenMessenger, amount) + deposit_for_burn(...). Sign + execute with
   * the SolanaAsStarknetAccount.
   */
  buildWithdrawToSolanaCalls(amount: bigint, recipientAta32: Uint8Array): Call[] {
    const sn = this.config.starknet;
    // max_fee is a CEILING on Circle's fee, not the burned amount. Floor at MIN_MAX_FEE
    // so a fast-finality burn never submits max_fee=0 (which can revert if the fee > 0).
    const computedFee = amount / MAX_FEE_BPS;
    const maxFee = computedFee > MIN_MAX_FEE ? computedFee : MIN_MAX_FEE;
    const mintRecipient = solanaAddrToU256(recipientAta32);
    return [
      {
        contractAddress: sn.usdc,
        entrypoint: "approve",
        calldata: CallData.compile({
          spender: sn.tokenMessenger,
          amount: uint256.bnToUint256(amount),
        }),
      },
      {
        contractAddress: sn.tokenMessenger,
        entrypoint: "deposit_for_burn",
        calldata: CallData.compile({
          amount: uint256.bnToUint256(amount),
          destination_domain: this.config.solana.domain,
          mint_recipient: uint256.bnToUint256(mintRecipient),
          burn_token: sn.usdc,
          destination_caller: uint256.bnToUint256(0n), // permissionless mint on Solana
          max_fee: uint256.bnToUint256(maxFee),
          min_finality_threshold: FINALITY_THRESHOLD_FAST,
        }),
      },
    ];
  }

  /**
   * Convenience wrapper over `buildWithdrawToSolanaCalls`: derives the USDC
   * associated-token account for `ownerPubkey` and builds the burn calls that
   * send USDC to it. Pass the connected wallet's pubkey (the same wallet used for
   * deposits) to withdraw back to that wallet. The caller is responsible for
   * passing the intended owner; any pubkey's USDC ATA can be targeted, so this
   * does not itself guarantee funds return to the connected wallet. Sign and
   * execute the returned calls with the SolanaAsStarknetAccount (paymaster-sponsored).
   */
  async buildWithdrawToOwnerCalls(amount: bigint, ownerPubkey: string): Promise<Call[]> {
    const recipientAta = await this.solanaUsdcAtaBytes(ownerPubkey);
    return this.buildWithdrawToSolanaCalls(amount, recipientAta);
  }

  /**
   * Build the permissionless `receive_message(message, attestation)` call on the
   * Starknet MessageTransmitter to mint the bridged USDC at the sol_account.
   */
  buildReceiveOnStarknetCall(message: string, attestation: string): Call {
    return {
      contractAddress: this.config.starknet.messageTransmitter,
      entrypoint: "receive_message",
      calldata: [...hexToByteArrayCalldata(message), ...hexToByteArrayCalldata(attestation)],
    };
  }

  /**
   * Lazily build an anchor provider + the two CCTP V2 programs against the live
   * on-chain IDLs. No signing here — we build a Transaction and hand it to
   * Phantom's signAndSendTransaction, so a no-op wallet (just the pubkey) suffices.
   */
  protected async loadSolanaPrograms(connection: any, ownerPubkey: string) {
    const anchor = await import("@coral-xyz/anchor");
    const { PublicKey } = await import("@solana/web3.js");
    const wallet = {
      publicKey: new PublicKey(ownerPubkey),
      signTransaction: async (tx: any) => tx,
      signAllTransactions: async (txs: any) => txs,
    };
    const provider = new anchor.AnchorProvider(connection, wallet as any, {
      commitment: "confirmed",
    });
    const TMM = new PublicKey(this.config.solana.tokenMessengerMinter);
    const MT = new PublicKey(this.config.solana.messageTransmitter);
    const [tmmIdl, mtIdl] = await Promise.all([
      anchor.Program.fetchIdl(TMM, provider),
      anchor.Program.fetchIdl(MT, provider),
    ]);
    if (!tmmIdl || !mtIdl) throw new Error("Failed to fetch CCTP program IDLs from Solana");
    const tmm = new anchor.Program(tmmIdl as any, provider);
    const mt = new anchor.Program(mtIdl as any, provider);
    return { anchor, PublicKey, tmm, mt };
  }

  /**
   * Burn USDC on Solana (CCTP V2 `depositForBurn`) destined for the sol_account on
   * Starknet. Standard finality + maxFee 0 → no CCTP fee, so minted == burned. The
   * ephemeral messageSentEventData keypair co-signs; Phantom adds the owner sig.
   */
  async depositFromSolana(params: DepositParams): Promise<string> {
    const { amount, starknetRecipient, signAndSend, ownerPubkey } = params;
    const { Connection, Keypair, SystemProgram } = await import("@solana/web3.js");
    const spl = await import("@solana/spl-token");
    const connection = new Connection(this.config.solana.rpcUrl, "confirmed");
    const { anchor, PublicKey, tmm, mt } = await this.loadSolanaPrograms(connection, ownerPubkey);

    const owner = new PublicKey(ownerPubkey);
    const usdc = new PublicKey(this.config.solana.usdcMint);
    const burnTokenAccount = await spl.getAssociatedTokenAddress(usdc, owner);
    const mintRecipient = new PublicKey(feltTo32BE(starknetRecipient));

    const remoteDomain = String(this.config.starknet.domain);
    const messageTransmitter = findPda(PublicKey, "message_transmitter", mt.programId);
    const tokenMessenger = findPda(PublicKey, "token_messenger", tmm.programId);
    const remoteTokenMessenger = findPda(PublicKey, "remote_token_messenger", tmm.programId, [
      remoteDomain,
    ]);
    const tokenMinter = findPda(PublicKey, "token_minter", tmm.programId);
    const senderAuthorityPda = findPda(PublicKey, "sender_authority", tmm.programId);
    const localToken = findPda(PublicKey, "local_token", tmm.programId, [usdc]);

    const messageSentEventData = Keypair.generate();

    const tx = await tmm.methods
      .depositForBurn({
        amount: new anchor.BN(amount.toString()),
        destinationDomain: this.config.starknet.domain,
        mintRecipient,
        destinationCaller: PublicKey.default, // permissionless mint on Starknet
        maxFee: new anchor.BN(0),
        minFinalityThreshold: FINALITY_THRESHOLD_STANDARD, // standard (free, exact amount)
      })
      .accountsPartial({
        owner,
        eventRentPayer: owner,
        senderAuthorityPda,
        burnTokenAccount,
        messageTransmitter,
        tokenMessenger,
        remoteTokenMessenger,
        tokenMinter,
        localToken,
        burnTokenMint: usdc,
        messageSentEventData: messageSentEventData.publicKey,
        messageTransmitterProgram: mt.programId,
        tokenMessengerMinterProgram: tmm.programId,
        tokenProgram: spl.TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .transaction();

    tx.feePayer = owner;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.partialSign(messageSentEventData);
    return await signAndSend(tx);
  }

  /**
   * Mint bridged USDC on Solana via `receive_message` on the V2 MessageTransmitter
   * (CPIs into TokenMessengerMinter). Permissionless — the connected user signs and
   * pays the SOL fee. Creates the recipient USDC ATA idempotently if needed.
   */
  async receiveOnSolana(p: ReceiveOnSolanaParams): Promise<string> {
    const { Connection, SystemProgram } = await import("@solana/web3.js");
    const spl = await import("@solana/spl-token");
    const connection = new Connection(this.config.solana.rpcUrl, "confirmed");
    const { PublicKey, tmm, mt } = await this.loadSolanaPrograms(connection, p.ownerPubkey);

    const owner = new PublicKey(p.ownerPubkey);
    const usdc = new PublicKey(this.config.solana.usdcMint);
    const userTokenAccount = await spl.getAssociatedTokenAddress(usdc, owner);

    // V2 nonce = message bytes [12..44] (32 bytes).
    const messageBytes = hexToBytes(p.message);
    if (messageBytes.length < 44)
      throw new Error(
        `CCTP message too short: need >= 44 bytes for the nonce, got ${messageBytes.length}`,
      );
    const nonce = messageBytes.subarray(12, 44);

    const remoteDomain = String(this.config.starknet.domain);
    const remoteTokenKey = new PublicKey(feltTo32BE(this.config.starknet.usdc));

    const messageTransmitter = findPda(PublicKey, "message_transmitter", mt.programId);
    const tokenMessenger = findPda(PublicKey, "token_messenger", tmm.programId);
    const tokenMinter = findPda(PublicKey, "token_minter", tmm.programId);
    const localToken = findPda(PublicKey, "local_token", tmm.programId, [usdc]);
    const remoteTokenMessenger = findPda(PublicKey, "remote_token_messenger", tmm.programId, [
      remoteDomain,
    ]);
    const tokenPair = findPda(PublicKey, "token_pair", tmm.programId, [
      remoteDomain,
      remoteTokenKey,
    ]);
    const custodyTokenAccount = findPda(PublicKey, "custody", tmm.programId, [usdc]);
    const authorityPda = findPda(PublicKey, "message_transmitter_authority", mt.programId, [
      tmm.programId,
    ]);
    const tokenMessengerEventAuthority = findPda(PublicKey, "__event_authority", tmm.programId);
    const usedNonce = findPda(PublicKey, "used_nonce", mt.programId, [nonce]);

    // The fee recipient's USDC ATA — read the fee recipient off the TokenMessenger.
    const tokenMessengerAcc: any = await (tmm.account as any).tokenMessenger.fetch(tokenMessenger);
    const feeRecipientTokenAccount = await spl.getAssociatedTokenAddress(
      usdc,
      tokenMessengerAcc.feeRecipient,
    );

    const remainingAccounts = [
      { isSigner: false, isWritable: false, pubkey: tokenMessenger },
      { isSigner: false, isWritable: false, pubkey: remoteTokenMessenger },
      { isSigner: false, isWritable: true, pubkey: tokenMinter },
      { isSigner: false, isWritable: true, pubkey: localToken },
      { isSigner: false, isWritable: false, pubkey: tokenPair },
      { isSigner: false, isWritable: true, pubkey: feeRecipientTokenAccount },
      { isSigner: false, isWritable: true, pubkey: userTokenAccount },
      { isSigner: false, isWritable: true, pubkey: custodyTokenAccount },
      { isSigner: false, isWritable: false, pubkey: spl.TOKEN_PROGRAM_ID },
      { isSigner: false, isWritable: false, pubkey: tokenMessengerEventAuthority },
      { isSigner: false, isWritable: false, pubkey: tmm.programId },
    ];

    // Buffer must be available (the consuming app polyfills it in the browser).
    const tx = await mt.methods
      .receiveMessage({
        message: Buffer.from(messageBytes),
        attestation: Buffer.from(hexToBytes(p.attestation)),
      })
      .accountsPartial({
        payer: owner,
        caller: owner,
        authorityPda,
        messageTransmitter,
        usedNonce,
        receiver: tmm.programId,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(remainingAccounts)
      .transaction();

    const ataInfo = await connection.getAccountInfo(userTokenAccount);
    if (!ataInfo) {
      tx.instructions.unshift(
        spl.createAssociatedTokenAccountIdempotentInstruction(owner, userTokenAccount, owner, usdc),
      );
    }

    tx.feePayer = owner;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    return await p.signAndSend(tx);
  }

  /** The connected Solana wallet's USDC associated-token-account (base58). */
  async solanaUsdcAta(ownerPubkey: string): Promise<string> {
    const { PublicKey } = await import("@solana/web3.js");
    const spl = await import("@solana/spl-token");
    const ata = await spl.getAssociatedTokenAddress(
      new PublicKey(this.config.solana.usdcMint),
      new PublicKey(ownerPubkey),
    );
    return ata.toBase58();
  }

  /** The connected wallet's USDC ATA as raw 32 bytes — the mint_recipient for withdraws. */
  async solanaUsdcAtaBytes(ownerPubkey: string): Promise<Uint8Array> {
    const { PublicKey } = await import("@solana/web3.js");
    const spl = await import("@solana/spl-token");
    const ata = await spl.getAssociatedTokenAddress(
      new PublicKey(this.config.solana.usdcMint),
      new PublicKey(ownerPubkey),
    );
    return ata.toBytes();
  }

  /** Read the connected wallet's USDC balance (raw, 6 decimals). 0 if no ATA; transport failures throw. */
  async solanaUsdcBalance(ownerPubkey: string): Promise<bigint> {
    const { Connection, PublicKey, SolanaJSONRPCError } = await import("@solana/web3.js");
    const spl = await import("@solana/spl-token");
    const connection = new Connection(this.config.solana.rpcUrl, "confirmed");
    const ata = await spl.getAssociatedTokenAddress(
      new PublicKey(this.config.solana.usdcMint),
      new PublicKey(ownerPubkey),
    );
    try {
      const bal = await connection.getTokenAccountBalance(ata);
      return BigInt(bal.value.amount);
    } catch (error) {
      // A missing ATA arrives as INVALID_PARAMS_ERROR_CODE plus
      // "Invalid param: could not find account", wrapped by web3.js as
      // SolanaJSONRPCError. That full shape means "no ATA yet". Anything else
      // (403/rate-limit/network) is a transport failure and must surface, not
      // masquerade as a zero balance.
      if (
        error instanceof SolanaJSONRPCError &&
        error.code === INVALID_PARAMS_ERROR_CODE &&
        ACCOUNT_NOT_FOUND_MESSAGE_RE.test(error.message)
      ) {
        return 0n; // ATA not created yet
      }
      throw error;
    }
  }

  // ─── In-flight recovery (storage-free) ───
  // A transfer that burned on the source chain but never minted on the
  // destination has no destination footprint, so we discover it from the SOURCE
  // chain (the user's own burn history) and complete the destination leg.
  // Already-minted burns are filtered by the destination's used-nonce check, so
  // completed transfers never resurface.

  private async circleMessages(sourceDomain: number, txHash: string): Promise<any[]> {
    try {
      const res = await fetch(
        `${this.config.attestationApi}/v2/messages/${sourceDomain}?transactionHash=${txHash}`,
      );
      if (!res.ok) return [];
      const data = (await res.json()) as { messages?: any[] };
      return data.messages ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Find Solana→Starknet burns that attested but were never minted into
   * `starknetRecipient` (recoverable by a Starknet receive). Scans the connected
   * wallet's recent Solana txs; filters to domain-25 burns for the recipient whose
   * nonce isn't yet used on Starknet.
   */
  async findRecoverableDeposits(
    ownerPubkey: string,
    starknetRecipient: string,
  ): Promise<RecoverableDeposit[]> {
    const { Connection, PublicKey } = await import("@solana/web3.js");
    const connection = new Connection(this.config.solana.rpcUrl, "confirmed");
    // Paginate the wallet's signature history (newest-first via `before`) so a
    // stuck burn behind unrelated activity is still found, bounded by
    // DEPOSIT_SCAN_MAX_SIGNATURES.
    const sigs: { signature: string }[] = [];
    let beforeSig: string | undefined = undefined;
    while (sigs.length < DEPOSIT_SCAN_MAX_SIGNATURES) {
      const page = await connection.getSignaturesForAddress(new PublicKey(ownerPubkey), {
        limit: DEPOSIT_SCAN_SIGNATURE_PAGE,
        before: beforeSig,
      });
      if (page.length === 0) break;
      sigs.push(...page);
      beforeSig = page[page.length - 1].signature;
      if (page.length < DEPOSIT_SCAN_SIGNATURE_PAGE) break; // reached the end of history
    }
    const target = BigInt(starknetRecipient);
    const sn = new RpcProvider({ nodeUrl: this.config.starknetRpcUrl });
    const out: RecoverableDeposit[] = [];

    // TODO: the per-signature circleMessages + is_nonce_used calls are
    // independent; batch them with bounded-concurrency Promise.all to cut
    // latency for wallets with many burns. Kept sequential here to avoid a
    // refactor of fund-critical recovery logic.
    for (const s of sigs) {
      for (const m of await this.circleMessages(this.config.solana.domain, s.signature)) {
        if (m.status !== "complete" || !m.message || !m.attestation) continue;
        const fields = parseCctpBurnMessage(hexToBytes(m.message));
        if (!fields) continue;
        if (fields.destDomain !== this.config.starknet.domain) continue; // dest domain
        if (fields.mintRecipient !== target) continue; // mint_recipient
        const nonce = fields.nonce;
        try {
          const r = await sn.callContract({
            contractAddress: this.config.starknet.messageTransmitter,
            entrypoint: "is_nonce_used",
            calldata: CallData.compile({ nonce: uint256.bnToUint256(nonce) }),
          });
          if (BigInt(r[0]) !== 0n) continue; // already minted on Starknet
        } catch {
          /* if the check errors, fall through; the recover attempt's estimate guards it */
        }
        out.push({
          burnSig: s.signature,
          amount: fields.amount,
          message: m.message,
          attestation: m.attestation,
        });
      }
    }
    return out;
  }

  /**
   * Find Starknet→Solana burns that attested but were never minted on Solana
   * (recoverable by a Solana receive_message). Discovers the sol_account's
   * DepositForBurn events on the Starknet TokenMessenger (keyed by depositor),
   * filters to domain-5 mints for the user's USDC ATA whose nonce isn't used on Solana.
   */
  async findRecoverableWithdrawals(
    starknetSender: string,
    solanaOwner: string,
  ): Promise<RecoverableWithdraw[]> {
    const { Connection, PublicKey } = await import("@solana/web3.js");
    const connection = new Connection(this.config.solana.rpcUrl, "confirmed");
    const sn = new RpcProvider({ nodeUrl: this.config.starknetRpcUrl });

    const recipientAta = await this.solanaUsdcAtaBytes(solanaOwner);
    const recipientTarget = beToBig(recipientAta);
    const mtPubkey = new PublicKey(this.config.solana.messageTransmitter);

    // Scan a bounded RECENT window (not from block 0) to stay fast.
    const latest = await sn.getBlockNumber();
    const fromBlock = Math.max(0, latest - WITHDRAW_SCAN_WINDOW);

    // DepositForBurn keys: [selector, burn_token, depositor, ...] → filter by depositor.
    const selector = hash.getSelectorFromName("DepositForBurn");
    // Normalize the depositor felt so a 0x-padded vs unpadded address can't cause
    // a format-dependent miss when the node matches the key by value.
    const depositorKey = num.toHex(BigInt(starknetSender));
    const txHashes = new Set<string>();
    let continuationToken: string | undefined = undefined;
    for (let page = 0; page < WITHDRAW_EVENT_PAGE_LIMIT; page++) {
      const res: any = await sn.getEvents({
        address: this.config.starknet.tokenMessenger,
        from_block: { block_number: fromBlock },
        to_block: "latest",
        keys: [[selector], [], [depositorKey]],
        chunk_size: 1000,
        continuation_token: continuationToken,
      });
      for (const ev of res.events ?? []) txHashes.add(ev.transaction_hash);
      continuationToken = res.continuation_token;
      if (!continuationToken) break;
    }

    const out: RecoverableWithdraw[] = [];
    // TODO: the per-txHash circleMessages + used_nonce PDA lookups are
    // independent; batch them with bounded-concurrency Promise.all to cut
    // latency. Kept sequential here to avoid a refactor of fund-critical
    // recovery logic.
    for (const txHash of txHashes) {
      for (const m of await this.circleMessages(this.config.starknet.domain, txHash)) {
        if (m.status !== "complete" || !m.message || !m.attestation) continue;
        const fields = parseCctpBurnMessage(hexToBytes(m.message));
        if (!fields) continue;
        if (fields.destDomain !== this.config.solana.domain) continue; // dest = Solana
        if (fields.mintRecipient !== recipientTarget) continue; // mint_recipient ATA
        // Dedup: the used_nonce PDA exists once the message has been received on Solana.
        const usedNonce = findPda(PublicKey, "used_nonce", mtPubkey, [fields.nonceBytes]);
        const info = await connection.getAccountInfo(usedNonce);
        if (info) continue; // already minted on Solana
        out.push({ starknetTx: txHash, message: m.message, attestation: m.attestation });
      }
    }
    return out;
  }
}
