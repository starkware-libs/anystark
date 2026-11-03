// ─── garaga EdDSA hint generation (browser, no relayer) ───
// Turns a Phantom Ed25519 signature into the felt calldata that
// packages/contracts (sol_account, garaga 1.1.0) deserializes as an
// EdDSASignatureWithHint. garaga's WASM `eddsaCalldataBuilder` computes the MSM /
// sqrt hints and emits the bundle in the exact Serde order the Cairo struct expects:
// (Ry, s, msg, msm_hint, sqrt hints). The account passes its stored signer to the
// verifier as Py_twisted, so the bundle carries no public key of its own.
//
// The whole garaga WASM module is loaded lazily so it never weighs down the main
// bundle — only when the user actually signs.

import { pubkeyToU256Limbs } from "./key_to_address";

/**
 * Build the serialized `EdDSASignatureWithHint` felts the sol_account expects.
 *
 * @param pubkey 32-byte Ed25519 public key (Phantom `publicKey.toBytes()`)
 * @param sig64In 64-byte Phantom signature (R ‖ s, each 32 bytes little-endian)
 * @param msg    the exact bytes that were signed
 * @returns hex felts ready to use as the Starknet tx `signature`
 */
export async function buildEddsaSignatureFelts(
  pubkey: Uint8Array,
  sig64In: Uint8Array,
  msg: Uint8Array,
): Promise<string[]> {
  // Phantom may return the signature as a Buffer/array-like; normalize to bytes.
  const sig64 =
    sig64In instanceof Uint8Array ? sig64In : new Uint8Array(sig64In as ArrayLike<number>);
  const pk = pubkey instanceof Uint8Array ? pubkey : new Uint8Array(pubkey as ArrayLike<number>);
  if (sig64.length !== 64) throw new Error(`signature must be 64 bytes, got ${sig64.length}`);
  if (pk.length !== 32) throw new Error(`pubkey must be 32 bytes, got ${pk.length}`);
  const garaga = await loadGaraga();

  const garaga_ry = signatureRy(sig64);
  const garaga_s = signatureS(sig64);
  // Reuse the single source of truth for the fund-critical pubkey->u256 encoding
  // (same LE-bytes + 128-bit-limb split as the address derivation, locked by its
  // vector). The key is still an input to garaga's hint computation (the sqrt_Px hint),
  // and pubkeyToU256Limbs also enforces canonicality, so a non-canonical key is rejected
  // here before any signing.
  const { pk: garaga_py } = pubkeyToU256Limbs(pk);

  // The Cairo v1 struct carries no Py (the account verifies against its stored key), so
  // have garaga omit the public key from the emitted bundle. What remains is exactly the
  // Serde order the contract deserializes: [Ry, s, msg, msm_hint, sqrt hints].
  const prependPublickey = false;
  const calldata = garaga.eddsaCalldataBuilder(
    garaga_ry,
    garaga_s,
    garaga_py,
    msg,
    prependPublickey,
  );
  if (!Array.isArray(calldata) || calldata.length < 5) {
    throw new Error(
      `garaga eddsaCalldataBuilder returned ${typeof calldata} (len ${(calldata as unknown[])?.length}) — WASM init issue?`,
    );
  }
  return calldata.map((x) => "0x" + x.toString(16));
}

let wasmReady: Promise<typeof import("garaga")> | null = null;

async function loadGaraga(): Promise<typeof import("garaga")> {
  if (!wasmReady) {
    wasmReady = (async () => {
      const g = await import("garaga");
      await g.init();
      return g;
    })();
    // If init fails, drop the cached rejected promise so the next call retries
    // the WASM load instead of replaying the failure forever.
    wasmReady.catch(() => {
      wasmReady = null;
    });
  }
  return wasmReady;
}

/** R's y-coordinate: first 32 bytes of the signature. */
function signatureRy(sig64: Uint8Array): bigint {
  return leToBigInt(sig64.slice(0, 32));
}

/** Scalar s: last 32 bytes of the signature. */
function signatureS(sig64: Uint8Array): bigint {
  return leToBigInt(sig64.slice(32, 64));
}

/** Little-endian bytes → bigint (byte 0 is least significant). */
function leToBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = 0; i < bytes.length; i++) n |= BigInt(bytes[i]) << BigInt(8 * i);
  return n;
}
