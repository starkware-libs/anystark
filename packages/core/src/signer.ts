// ─── SolanaAsStarknetSigner ───
// A starknet.js Signer whose root key is an external Solana wallet's Ed25519 key.
//
// starknet.js's base Signer computes the transaction hash for every flavour of
// tx and then calls `signRaw(msgHash)`. We override only `signRaw`: bind to the
// hash by signing a message whose FIXED TRAILING 44 bytes are the standard base64
// of the hash's 32 big-endian bytes (exactly what packages/contracts' sol_account
// base64-decodes and checks), then return the garaga EdDSA bundle felts as the
// signature. An optional human-readable `signingLabel` may prefix the hash so the
// wallet popup shows the user what they are approving.
//
// The wallet capability is captured by the minimal `SolanaSigner` seam (pubkey +
// raw-bytes signer) — the shape any external Solana wallet would provide.

import { Signer as StarknetSigner, type Signature } from "starknet";
import { buildEddsaSignatureFelts } from "./garaga";
import { LabeledExecutor } from "./labeled_executor";

/** Sign raw message bytes with the external wallet's key; returns the 64-byte sig. */
export type SignBytes = (message: Uint8Array) => Promise<Uint8Array>;

/**
 * Minimal capability the external Solana (non-Starknet) wallet provides to back a
 * sol_account: its 32-byte public key (for address derivation) and a raw-bytes
 * signer. This is the seam an external Solana wallet implements.
 */
export interface SolanaSigner {
  /** The wallet's 32-byte Ed25519 public key. */
  readonly pubkey: Uint8Array;
  /** Sign raw message bytes, returning the 64-byte Ed25519 signature. */
  signBytes: SignBytes;
}

// Standard base64 alphabet (RFC 4648): A-Z a-z 0-9 + /, one '=' pad. NOT url-safe.
const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** The base64 of 32 bytes is always exactly 44 chars (one '=' pad). */
const B64_HASH_LEN = 44;
/** Reused UTF-8 encoder (stateless, so a single shared instance is safe). */
const TEXT_ENCODER = new TextEncoder();
/** The '\n' that separates an optional label from the trailing base64 hash. */
const MSG_SEPARATOR = 0x0a;
/**
 * Contract cap (sol_account `MAX_MSG_LEN`): the 3-SHA-512-block ceiling
 * (64 + 303 + 17 = 384 = 3 * 128). The SDK mirrors it so an over-long label is
 * rejected BEFORE signing, not on-chain.
 */
export const MAX_MSG_LEN = 303;
/** Max UTF-8 bytes of a label: MAX_MSG_LEN - 44 (base64 hash) - 1 (separator) = 258. */
export const MAX_LABEL_BYTES = MAX_MSG_LEN - B64_HASH_LEN - 1;
/**
 * Codepoints barred from a label: Cc (C0 controls, DEL and C1, so `\n` and NEL), Cf
 * (bidi overrides and isolates U+202A-202E / U+2066-2069, zero-width U+200B-200D, BOM
 * U+FEFF, tag chars U+E0001-E007F), Zl and Zp (U+2028, U+2029), and Cs (lone
 * surrogates, which TextEncoder would otherwise silently rewrite to U+FFFD so the
 * signed bytes differ from the supplied string). Matched on the string, not on the
 * encoded bytes, where every byte of a multi-byte sequence is >= 0x80 and hides the
 * codepoint.
 */
const FORBIDDEN_LABEL_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;

/**
 * felt hash -> the standard base64 (44 chars, one '=' pad) of its 32 big-endian
 * bytes. Pure over Uint8Array (no `Buffer`, no `btoa`) so it runs identically in
 * browser and node. This is the exact string the sol_account base64-decodes back to
 * the hash and compares u256-exact.
 */
export function feltToBase64Hash(hashHex: string): string {
  const value = BigInt(hashHex);
  if (value < 0n) throw new Error(`hash ${hashHex} is negative`);
  const bytes = new Uint8Array(32);
  let remainder = value;
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(remainder & 0xffn);
    remainder >>= 8n;
  }
  if (remainder !== 0n) throw new Error(`hash ${hashHex} does not fit in 32 bytes`);

  let out = "";
  // 10 full 3-byte groups -> 40 chars.
  for (let i = 0; i < 30; i += 3) {
    const group = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out +=
      B64_ALPHABET[(group >> 18) & 63] +
      B64_ALPHABET[(group >> 12) & 63] +
      B64_ALPHABET[(group >> 6) & 63] +
      B64_ALPHABET[group & 63];
  }
  // Final 2 bytes -> 3 chars + one '=' pad (the char before '=' carries only 4 bits,
  // so its low 2 bits are zero, matching the contract's canonical-pad-bit check).
  const tail = (bytes[30] << 8) | bytes[31];
  out +=
    B64_ALPHABET[(tail >> 10) & 63] +
    B64_ALPHABET[(tail >> 4) & 63] +
    B64_ALPHABET[(tail << 2) & 63] +
    "=";

  if (out.length !== B64_HASH_LEN) {
    throw new Error(`base64 hash must be ${B64_HASH_LEN} chars, got ${out.length}`);
  }
  return out;
}

/**
 * Assemble the exact bytes the wallet signs and the account verifies:
 *   - no label:  `base64(hash)`                              (44 bytes)
 *   - with label: `utf8(label)` + `\n` + `base64(hash)`      (len + 1 + 44 bytes)
 *
 * READABLE-LABEL LENGTH LIMITS AND GAS TRADEOFF (the account re-hashes the whole
 * message on EVERY validation, so this recurs per tx, forever):
 *   - no label       -> 44 bytes  -> 1 SHA-512 block  (cheapest, but NOT recommended:
 *                       the user signs an opaque blob, so the wallet popup is unreadable).
 *   - label <=130 chars -> <=175 bytes -> 2 SHA-512 blocks.
 *   - label 131..258 chars -> <=303 bytes -> 3 SHA-512 blocks (the maximum; longer is
 *                       rejected here and by the contract's `MAX_MSG_LEN`=303).
 * Each extra SHA-512 block is roughly +5.3M sierra gas on every validation, so prefer
 * a succinct label; there is no gas difference between a 3-char and a 130-char label
 * (both are 2 blocks), so "use the block you already bought" and keep it one sentence.
 *
 * Control characters and invisible or text-reordering codepoints (see
 * `FORBIDDEN_LABEL_CHARS`) are rejected in the label so it cannot push the real hash
 * out of the wallet's view, hide itself from it, or read in a different order than the
 * bytes signed. The `\n` separator is added by the SDK alone. The label is ADVISORY:
 * Ed25519 covers every byte (nobody can alter a signed label), but the chain does NOT
 * check the label against the calls.
 */
export function assembleSignedMessage(hashHex: string, label?: string): Uint8Array {
  const base64Bytes = TEXT_ENCODER.encode(feltToBase64Hash(hashHex));
  if (label === undefined || label === "") return base64Bytes;

  if (FORBIDDEN_LABEL_CHARS.test(label)) {
    throw new Error(
      "signingLabel must not contain control characters (Unicode Cc, including `\\n`) or " +
        "invisible or text-reordering characters (Cf bidi overrides, isolates, zero-width " +
        "characters and the BOM; Zl and Zp line/paragraph separators; Cs lone surrogates). " +
        "Such a character could hide the signed hash in the wallet popup, reorder what it " +
        "shows, or make the signed bytes differ from the label supplied.",
    );
  }
  const labelBytes = TEXT_ENCODER.encode(label);
  if (labelBytes.length > MAX_LABEL_BYTES) {
    throw new Error(
      `signingLabel is ${labelBytes.length} UTF-8 bytes; the maximum is ${MAX_LABEL_BYTES} ` +
        `(contract MAX_MSG_LEN=${MAX_MSG_LEN} = label + 1 separator + 44-byte base64 hash).`,
    );
  }

  const message = new Uint8Array(labelBytes.length + 1 + base64Bytes.length);
  message.set(labelBytes, 0);
  message[labelBytes.length] = MSG_SEPARATOR;
  message.set(base64Bytes, labelBytes.length + 1);
  return message;
}

/** One static label for every signature, or a `LabeledExecutor` for per-action labels. */
export type SigningLabel = string | LabeledExecutor;

// Name the received value for the rejection message: its type, and for an object its
// constructor name, which reads "LabeledExecutor" in the duplicated-package case.
function describeSigningLabel(value: unknown): string {
  if (value === null) return "null";
  if (typeof value !== "object") return `a ${typeof value}`;
  const ctor = (value as { constructor?: { name?: unknown } }).constructor?.name;
  if (typeof ctor === "string" && ctor.length > 0 && ctor !== "Object") {
    return `an object of type ${ctor}`;
  }
  return "a plain object";
}

// Resolve a SigningLabel to the one string (or undefined) for this signature: a string
// is used as-is, a LabeledExecutor consumes its own pending label via .resolve().
function resolveSigningLabel(signingLabel: SigningLabel | undefined): string | undefined {
  if (signingLabel === undefined || typeof signingLabel === "string") return signingLabel;
  // Widened so `instanceof` narrows the reject branch too: a JS caller (or a stale
  // typing) can pass anything here.
  const candidate: unknown = signingLabel;
  if (!(candidate instanceof LabeledExecutor)) {
    throw new Error(
      `signingLabel must be a string or a LabeledExecutor; got ${describeSigningLabel(candidate)}. ` +
        "A LabeledExecutor from a DUPLICATED @starkware-libs/anystark-core copy fails this " +
        "instanceof check: dedupe the package so the app and the SDK share one class.",
    );
  }
  const resolved: unknown = candidate.resolve();
  // resolve() is reachable from JS with any return value; TEXT_ENCODER would otherwise
  // stringify it into a label.
  if (resolved !== undefined && typeof resolved !== "string") {
    throw new Error(
      `signingLabel resolver must return a string or undefined; got ${typeof resolved}.`,
    );
  }
  return resolved;
}

export class SolanaAsStarknetSigner extends StarknetSigner {
  /**
   * @param external     the external Solana wallet's signing capability.
   * @param signingLabel optional human-readable label, either one static string or a
   *   `LabeledExecutor` supplying a per-action one, placed before the base64 hash in
   *   every signed message so the wallet popup shows the user what they approve.
   *   Default none (44-byte message, single SHA-512 block, cheapest). See
   *   `PhantomConnectorConfig.signingLabel` for the full contract and
   *   `assembleSignedMessage` for the length/gas tradeoff.
   */
  constructor(
    private readonly external: SolanaSigner,
    private readonly signingLabel?: SigningLabel,
  ) {
    // The base ctor wants a STARK key; it's unused because we override signRaw.
    super("0x1");
  }

  // Sign the hash the Phantom way. Phantom only agrees to sign text-based messages,
  // so we render the hash as base64 text (optionally after a readable label + `\n`)
  // and emit the garaga bundle. The sol_account base64-decodes the trailing 44 bytes
  // back to the felt and binds it to the operation hash.
  public override async signRaw(msgHash: string): Promise<Signature> {
    const label = resolveSigningLabel(this.signingLabel);
    const message = assembleSignedMessage(msgHash, label);
    const sig64 = await this.external.signBytes(message);
    return buildEddsaSignatureFelts(this.external.pubkey, sig64, message);
  }

  // This signer authenticates via the external Solana Ed25519 key, which is
  // 256-bit and does not fit into a felt — there is no STARK public key to
  // return. Only signRaw is meaningful here; guard the inherited getPubKey,
  // which would otherwise hand back a bogus getStarkKey("0x1").
  public override async getPubKey(): Promise<string> {
    throw new Error(
      "SolanaAsStarknetSigner has no STARK public key: the Solana Ed25519 key is 256-bit and does not fit into a felt.",
    );
  }
}
