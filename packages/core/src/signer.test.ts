import { describe, expect, it, vi } from "vitest";
import { OutsideExecutionVersion, constants, outsideExecution, type Call } from "starknet";
import { CHAIN_IDS } from "./config";
import { LabeledExecutor } from "./labeled_executor";
import {
  MAX_LABEL_BYTES,
  SolanaAsStarknetSigner,
  assembleSignedMessage,
  feltToBase64Hash,
} from "./signer";
import {
  LOCKED_B64,
  LOCKED_HASH_HEX,
  LOCKED_LABEL,
  LOCKED_PUBKEY,
  LOCKED_SIG64,
  LOCKED_SIG64_LABELED,
  lockedEd25519Signer,
} from "./test_vectors";

const decode = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

describe("feltToBase64Hash / assembleSignedMessage", () => {
  it("encodes the 32 big-endian bytes of the hash as 44-char standard base64", () => {
    const b64 = feltToBase64Hash(LOCKED_HASH_HEX);
    expect(b64).toBe(LOCKED_B64);
    expect(b64).toHaveLength(44);
    expect(b64.endsWith("=")).toBe(true);
  });

  it("no-label message is exactly the 44-byte base64 (single SHA-512 block)", () => {
    const msg = assembleSignedMessage(LOCKED_HASH_HEX);
    expect(msg).toHaveLength(44);
    expect(decode(msg)).toBe(LOCKED_B64);
  });

  it("empty-string label yields the bare 44-byte base64 with no leading separator", () => {
    const msg = assembleSignedMessage(LOCKED_HASH_HEX, "");
    expect(msg).toHaveLength(44);
    expect(decode(msg)).toBe(LOCKED_B64);
    // Same bytes as the no-label form: an empty label must NOT prepend a '\n' separator.
    expect(msg).toEqual(assembleSignedMessage(LOCKED_HASH_HEX));
  });

  it("labeled message is label + '\\n' + base64", () => {
    const msg = assembleSignedMessage(LOCKED_HASH_HEX, LOCKED_LABEL);
    expect(decode(msg)).toBe(`${LOCKED_LABEL}\n${LOCKED_B64}`);
  });

  it("rejects a label with control characters (spoofing guard)", () => {
    expect(() => assembleSignedMessage(LOCKED_HASH_HEX, "a\nb")).toThrow(/control character/);
    expect(() => assembleSignedMessage(LOCKED_HASH_HEX, "a\tb")).toThrow(/control character/);
  });

  it("rejects invisible and text-reordering label codepoints the byte check missed", () => {
    // DEL is a single byte the old `< 0x20` check let through; the rest encode to bytes
    // that are all >= 0x80, so only a codepoint check sees them.
    const spoofing = {
      DEL: "\u007f",
      NEL: "\u0085",
      "RLO (bidi override)": "\u202e",
      "LRI (bidi isolate)": "\u2066",
      "zero-width space": "\u200b",
      "zero-width joiner": "\u200d",
      BOM: "\ufeff",
      "line separator": "\u2028",
      "paragraph separator": "\u2029",
      "tag char (astral Cf)": "\u{e0041}",
      "lone surrogate": "\ud800",
    };
    for (const [name, char] of Object.entries(spoofing)) {
      expect(() => assembleSignedMessage(LOCKED_HASH_HEX, `pay 1 USDC${char}`), name).toThrow(
        /control character/,
      );
    }
  });

  it("accepts CJK, currency and emoji labels byte-identically", () => {
    for (const label of ["MyApp: pay 25 USDC", "轉帳 25 USDC", "€25 to alice", "pay 25 USDC 🚀"]) {
      const msg = assembleSignedMessage(LOCKED_HASH_HEX, label);
      expect(decode(msg)).toBe(`${label}\n${LOCKED_B64}`);
      expect(msg).toHaveLength(new TextEncoder().encode(label).length + 1 + 44);
    }
  });

  it("accepts a label at exactly the 258-byte budget and rejects 259", () => {
    const maxLabel = "x".repeat(MAX_LABEL_BYTES); // 258
    const msg = assembleSignedMessage(LOCKED_HASH_HEX, maxLabel);
    expect(msg).toHaveLength(303); // MAX_MSG_LEN
    expect(() => assembleSignedMessage(LOCKED_HASH_HEX, "x".repeat(MAX_LABEL_BYTES + 1))).toThrow(
      /maximum is 258/,
    );
  });

  it("counts the label in UTF-8 bytes, not code points", () => {
    // '€' is 3 UTF-8 bytes: 86 of them = 258 bytes (ok), 87 = 261 bytes (rejected).
    expect(() => assembleSignedMessage(LOCKED_HASH_HEX, "€".repeat(86))).not.toThrow();
    expect(() => assembleSignedMessage(LOCKED_HASH_HEX, "€".repeat(87))).toThrow(/maximum is 258/);
  });

  it("holds the byte boundary exactly for a mixed multi-byte and ASCII label", () => {
    const wide = "€".repeat(85); // 255 bytes, so the ASCII tail lands on the boundary.
    expect(assembleSignedMessage(LOCKED_HASH_HEX, `${wide}xxx`)).toHaveLength(303); // 258 bytes
    expect(() => assembleSignedMessage(LOCKED_HASH_HEX, `${wide}xxxx`)).toThrow(/maximum is 258/);
  });
});

describe("SolanaAsStarknetSigner.signRaw", () => {
  it("signs the base64 form of the hash (no label by default)", async () => {
    let captured: Uint8Array | undefined;
    const signer = new SolanaAsStarknetSigner({
      pubkey: LOCKED_PUBKEY,
      signBytes: async (msg) => {
        captured = msg;
        return LOCKED_SIG64;
      },
    });
    await signer.signRaw(LOCKED_HASH_HEX);
    expect(decode(captured)).toBe(LOCKED_B64);
  });

  it("encodes a short felt hash to the full 32-byte base64 (fixed width)", async () => {
    let captured: Uint8Array | undefined;
    const signer = new SolanaAsStarknetSigner({
      pubkey: LOCKED_PUBKEY,
      signBytes: async (msg) => {
        captured = msg;
        return LOCKED_SIG64;
      },
    });
    // starknet.js hands signRaw the unpadded felt hash; feltToBase64Hash always emits
    // the fixed-width 32 big-endian bytes, so the base64 is unchanged.
    await signer.signRaw("0x" + BigInt(LOCKED_HASH_HEX).toString(16));
    expect(decode(captured)).toBe(LOCKED_B64);
  });

  it("returns the locked garaga bundle for the no-label vector", async () => {
    const signer = new SolanaAsStarknetSigner({
      pubkey: LOCKED_PUBKEY,
      signBytes: async () => LOCKED_SIG64,
    });
    const sig = (await signer.signRaw(LOCKED_HASH_HEX)) as string[];
    // Layout: [Ry.lo, Ry.hi, s.lo, s.hi, msg_len, …]. The v1 bundle carries no Py; the
    // account verifies against its stored signer.
    expect(sig[4]).toBe("0x2c"); // msg_len = 44 (base64 hash, one SHA-512 block)
    expect(sig).toHaveLength(74);
  });

  it("prefixes the configured signingLabel (readable-label path)", async () => {
    let captured: Uint8Array | undefined;
    const signer = new SolanaAsStarknetSigner(
      {
        pubkey: LOCKED_PUBKEY,
        signBytes: async (msg) => {
          captured = msg;
          return LOCKED_SIG64_LABELED;
        },
      },
      LOCKED_LABEL,
    );
    const sig = (await signer.signRaw(LOCKED_HASH_HEX)) as string[];
    expect(decode(captured)).toBe(`${LOCKED_LABEL}\n${LOCKED_B64}`);
    expect(sig[4]).toBe("0x55"); // msg_len = 85 (label + '\n' + 44-byte base64, 2 blocks)
  });

  it("a LabeledExecutor labels each signature with the value given to its own execute()", async () => {
    const labeledExecutor = new LabeledExecutor();
    const resolveSpy = vi.spyOn(labeledExecutor, "resolve");
    const captured: (Uint8Array | undefined)[] = [];
    const signer = new SolanaAsStarknetSigner(
      {
        pubkey: LOCKED_PUBKEY,
        signBytes: async (msg) => {
          captured.push(msg);
          return LOCKED_SIG64_LABELED;
        },
      },
      labeledExecutor,
    );
    // Mirrors the real pipeline: account.execute() runs while the label is pending, and
    // signRaw (called from inside it) consumes it via resolve().
    const account = { execute: () => signer.signRaw(LOCKED_HASH_HEX) };
    await labeledExecutor.execute(account, [] as Call[], "buy 1 STRK for 2 USDC");
    await labeledExecutor.execute(account, [] as Call[], "buy 3 STRK for 6 USDC");
    expect(decode(captured[0])).toBe(`buy 1 STRK for 2 USDC\n${LOCKED_B64}`);
    expect(decode(captured[1])).toBe(`buy 3 STRK for 6 USDC\n${LOCKED_B64}`);
    // One resolve per execute(): a label maps to exactly one signature, so it can be
    // neither reused by a second signature nor skipped by the one it was set for.
    expect(resolveSpy).toHaveBeenCalledTimes(2);
  });

  it("a LabeledExecutor with no default and nothing pending signs the bare 44-byte hash", async () => {
    let captured: Uint8Array | undefined;
    const labeledExecutor = new LabeledExecutor();
    const signer = new SolanaAsStarknetSigner(
      {
        pubkey: LOCKED_PUBKEY,
        signBytes: async (msg) => {
          captured = msg;
          return LOCKED_SIG64;
        },
      },
      labeledExecutor,
    );
    await labeledExecutor.execute({ execute: () => signer.signRaw(LOCKED_HASH_HEX) }, [] as Call[]);
    expect(captured).toHaveLength(44);
    expect(decode(captured)).toBe(LOCKED_B64);
  });

  it("an execute() label of '' signs the bare 44-byte hash, overriding the default", async () => {
    const labeledExecutor = new LabeledExecutor("MyApp");
    let captured: Uint8Array | undefined;
    const signer = new SolanaAsStarknetSigner(
      {
        pubkey: LOCKED_PUBKEY,
        signBytes: async (msg) => {
          captured = msg;
          return LOCKED_SIG64;
        },
      },
      labeledExecutor,
    );
    await labeledExecutor.execute(
      { execute: () => signer.signRaw(LOCKED_HASH_HEX) },
      [] as Call[],
      "",
    );
    expect(captured).toHaveLength(44);
    expect(decode(captured)).toBe(LOCKED_B64);
  });

  it("an over-long execute() label throws the length error at sign time", async () => {
    const labeledExecutor = new LabeledExecutor();
    let signs = 0;
    const signer = new SolanaAsStarknetSigner(
      {
        pubkey: LOCKED_PUBKEY,
        signBytes: async () => {
          signs++;
          return LOCKED_SIG64;
        },
      },
      labeledExecutor,
    );
    const account = { execute: () => signer.signRaw(LOCKED_HASH_HEX) };
    const tooLong = "x".repeat(MAX_LABEL_BYTES + 1);
    await expect(labeledExecutor.execute(account, [] as Call[], tooLong)).rejects.toThrow(
      /maximum is 258/,
    );
    expect(signs).toBe(0); // no fallback to an unlabeled sign
  });

  it("a spoofing execute() label throws before reaching the wallet", async () => {
    const labeledExecutor = new LabeledExecutor();
    for (const char of ["\n", "\u007f", "\u200b", "\u202e", "\u2028"]) {
      let signs = 0;
      const signer = new SolanaAsStarknetSigner(
        {
          pubkey: LOCKED_PUBKEY,
          signBytes: async () => {
            signs++;
            return LOCKED_SIG64;
          },
        },
        labeledExecutor,
      );
      const account = { execute: () => signer.signRaw(LOCKED_HASH_HEX) };
      await expect(
        labeledExecutor.execute(account, [] as Call[], `pay 1 USDC${char}`),
      ).rejects.toThrow(/control character/);
      expect(signs).toBe(0);
    }
  });

  it("a non-string label sneaked past the types rejects, naming the type it got", async () => {
    let signs = 0;
    // A JS caller has no type check; the resolved value would otherwise be stringified.
    const labeledExecutor = new LabeledExecutor(42 as unknown as string);
    const signer = new SolanaAsStarknetSigner(
      {
        pubkey: LOCKED_PUBKEY,
        signBytes: async () => {
          signs++;
          return LOCKED_SIG64;
        },
      },
      labeledExecutor,
    );
    const account = { execute: () => signer.signRaw(LOCKED_HASH_HEX) };
    await expect(labeledExecutor.execute(account, [] as Call[])).rejects.toThrow(
      /string or undefined; got number/,
    );
    expect(signs).toBe(0);
  });

  it("a duplicated-package executor (resolve() but not instanceof) rejects with the dedupe hint", async () => {
    let signs = 0;
    // The shape a second copy of the package yields: a real executor whose class is a
    // different object, so instanceof is false. Rejecting names that cause instead of
    // silently signing unlabeled.
    const foreign = { resolve: () => "buy 1 STRK for 2 USDC" };
    const signer = new SolanaAsStarknetSigner(
      {
        pubkey: LOCKED_PUBKEY,
        signBytes: async () => {
          signs++;
          return LOCKED_SIG64;
        },
      },
      foreign as unknown as LabeledExecutor,
    );
    await expect(signer.signRaw(LOCKED_HASH_HEX)).rejects.toThrow(
      /must be a string or a LabeledExecutor; got a plain object/,
    );
    await expect(signer.signRaw(LOCKED_HASH_HEX)).rejects.toThrow(/DUPLICATED/);
    expect(signs).toBe(0);
  });

  it("a default-only LabeledExecutor (nothing pending) labels with the default", async () => {
    let captured: Uint8Array | undefined;
    const labeledExecutor = new LabeledExecutor("MyApp");
    const signer = new SolanaAsStarknetSigner(
      {
        pubkey: LOCKED_PUBKEY,
        signBytes: async (msg) => {
          captured = msg;
          return LOCKED_SIG64_LABELED;
        },
      },
      labeledExecutor,
    );
    await labeledExecutor.execute({ execute: () => signer.signRaw(LOCKED_HASH_HEX) }, [] as Call[]);
    expect(decode(captured)).toBe(`MyApp\n${LOCKED_B64}`);
  });

  it("bypassing the executor rejects at sign time instead of signing under the default", async () => {
    const labeledExecutor = new LabeledExecutor("MyApp");
    let signs = 0;
    const signer = new SolanaAsStarknetSigner(
      {
        pubkey: LOCKED_PUBKEY,
        signBytes: async () => {
          signs++;
          return LOCKED_SIG64;
        },
      },
      labeledExecutor,
    );
    // A bare signRaw call, not wrapped in labeledExecutor.execute(): the same account
    // signs fine through execute() (see the tests above) but rejects when bypassed.
    await expect(signer.signRaw(LOCKED_HASH_HEX)).rejects.toThrow(
      /outside LabeledExecutor\.execute\(\)/,
    );
    expect(signs).toBe(0);
  });
});

// ─── Locked SNIP-9 outside-execution vector (the sponsored-execution signing path) ───
// Generated by packages/core/scripts/gen_snip9_vector.mjs (lands with the contracts
// stack), which HARD-FAILS unless the TS-side SNIP-12 rev-1 hash of the tuple below
// matches OZ's Cairo get_message_hash. The exact same felts are executed ON-CHAIN by
// packages/contracts/src/test_outside_execution.cairo, so this locks the full off-chain
// paymaster path - starknet.js typed data → SNIP-12 hash bound to the account → base64
// message → garaga bundle - to what the deployed account verifies. Do not edit without
// re-generating (and re-verifying) the vector.
const SNIP9_VECTOR_ACCOUNT = "0x1234";
// prettier-ignore
const SNIP9_VECTOR_FELTS = [
  "0xeefe92b09aee1a13afdbcb60a41cac1", "0x83bfd9a836d507c7deba2e726a738642", "0x422714ba002ab523db24e893366d40a6", "0x57f8fa30d891c51d72d42ccdce16eed", "0x2c", "0x42", "0x73", "0x57", "0x68", "0x4b", "0x63", "0x4a", "0x57", "0x2b", "0x44", "0x33", "0x47", "0x4b", "0x4d", "0x77", "0x6a", "0x75", "0x6c", "0x50", "0x30", "0x61", "0x4b", "0x6d", "0x59", "0x77", "0x66", "0x64", "0x43", "0x76", "0x64", "0x63", "0x4d", "0x48", "0x74", "0x74", "0x74", "0x36", "0x58", "0x44", "0x2b", "0x36", "0x49", "0x63", "0x3d", "0x14", "0x1ea70d24eb53a6aedacdae0d", "0x3e2c88d58a17b9dec12fab90", "0x70a6e0b007e95480", "0x0", "0xdda63cf02d49aa53d945d86f", "0xc2cb87e25aa4a55c71fd4781", "0x308322d1336cb558", "0x0", "0x305c3faef54489bf80c1e0e1df41dd5f", "0x119ed840ea802cbad7a9a1223c5f800ed", "0x1f35d79be8f88ea2cb0dff50", "0xc8d5707211e66a7079e1ddd", "0x444c0959f11c9ea6", "0x0", "0x26d0323c5877b52044ffb302", "0xcf2627eb03cfcb01598f0e3a", "0x4416af0eb9416726", "0x0", "0x10eee202e25bc50df453a2d3d5d00fa2", "0x11d2d348771ad8bc8aec9629f1a580347", "0x5897ebe67e164ca891c47cd1dacd8e8f", "0x753c051d54614db1cbdc11e3686bc990", "0xc95fb5a1cbb999c4629a4836155d1d73", "0x22f0627bcb72c7ea8aa709cdce7618d3",
];

describe("SolanaAsStarknetSigner.getPubKey", () => {
  it("rejects: there is no STARK public key for the Solana Ed25519 key", async () => {
    const signer = new SolanaAsStarknetSigner(lockedEd25519Signer());
    await expect(signer.getPubKey()).rejects.toThrow("no STARK public key");
  });
});

describe("SolanaAsStarknetSigner.signMessage (SNIP-9 outside execution)", () => {
  it("reproduces the locked TS<->Cairo vector felt-for-felt", async () => {
    // The vector's tuple, rebuilt with the same starknet.js helper the generator uses:
    // chainId SN_SEPOLIA, caller ANY_CALLER, nonce 0x1, window (0, 3600), one call
    // { to: 0x5678, entrypoint: transfer, calldata: [0xcafe] }.
    const typedData = outsideExecution.getTypedData(
      CHAIN_IDS.sepolia,
      { caller: constants.OutsideExecutionCallerAny, execute_after: 0, execute_before: 3600 },
      "0x1",
      [{ contractAddress: "0x5678", entrypoint: "transfer", calldata: ["0xcafe"] }],
      OutsideExecutionVersion.V2,
    );
    const signer = new SolanaAsStarknetSigner(lockedEd25519Signer());
    // signMessage folds SNIP9_VECTOR_ACCOUNT into the SNIP-12 hash — the same
    // address-binding the sponsored execute() relies on.
    const felts = (await signer.signMessage(typedData, SNIP9_VECTOR_ACCOUNT)) as string[];
    expect(felts).toEqual(SNIP9_VECTOR_FELTS);
  });
});
