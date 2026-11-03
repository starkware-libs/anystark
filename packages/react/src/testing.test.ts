import { createPublicKey, verify as ed25519Verify, type KeyObject } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { CHAIN_IDS, PhantomProviderWrapper } from "@starkware-libs/anystark-core";
// Import the derivation helpers via @starkware-libs/anystark-react's own entry, exercising the 6.3
// re-exports at the same time.
import { deriveSolAccountAddress, resolveDeployClassHash } from "./index";
import { PhantomConnector } from "./connector";
import * as testing from "./testing";
import {
  MOCK_PHANTOM_PUBKEY,
  MockPhantomConnector,
  MockPhantomProvider,
  installMockPhantom,
} from "./testing";

const config = {
  starknetRpcUrl: "http://localhost:5050",
  chainId: CHAIN_IDS.sepolia,
  paymaster: { nodeUrl: "http://paymaster.localhost" },
};

// The repo's canonical deterministic test key (Ed25519 seed = bytes 0..31), pinned
// as LOCKED_PUBKEY in @starkware-libs/anystark-core's test_vectors.ts. Cross-checking the mock against
// it guarantees the mock signs with the SAME key the SDK's locked vectors use.
// prettier-ignore
const LOCKED_PUBKEY = Uint8Array.from([3, 161, 7, 191, 243, 206, 16, 190, 29, 112, 221, 24, 231, 75, 192, 153, 103, 228, 214, 48, 155, 165, 13, 95, 29, 220, 134, 100, 18, 85, 49, 184]);

// Locked cross-implementation vector copied from @starkware-libs/anystark-core's test_vectors.ts (which
// is intentionally NOT a public export): a real Ed25519 signature by the seed-0..31
// key over the "0x"+hex64 UTF-8 text of LOCKED_HASH. Pinning the mock's output
// against it catches a future signer/crypto-lib swap that changes the bytes.
const LOCKED_HASH = 0x1a2b3c4d5e6f70819293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8n;
const LOCKED_HASH_TEXT = "0x" + LOCKED_HASH.toString(16).padStart(64, "0");
// prettier-ignore
const LOCKED_SIG64 = Uint8Array.from([203, 95, 17, 147, 90, 141, 41, 120, 44, 151, 141, 249, 212, 55, 83, 22, 215, 50, 240, 179, 212, 94, 176, 97, 159, 12, 216, 16, 106, 14, 84, 158, 253, 95, 101, 227, 23, 173, 212, 24, 133, 142, 15, 6, 109, 22, 212, 108, 233, 144, 253, 56, 170, 79, 7, 121, 90, 108, 35, 196, 57, 28, 96, 0]);

// Counterfactual sol_account address for MOCK_PHANTOM_PUBKEY against sepolia's
// frozen deploy class hash. Regenerate only if the sepolia deploy hash changes.
const MOCK_SEPOLIA_ADDRESS = "0x485f7066476cb994355293349f4a06cd3255069002d06b15d6fd45d2ea5c97e";

/** Wrap a raw 32-byte Ed25519 public key into a verifiable KeyObject. */
function ed25519PublicKey(raw32: Uint8Array): KeyObject {
  const ED25519_SPKI_PREFIX = "302a300506032b6570032100";
  return createPublicKey({
    key: Buffer.concat([Buffer.from(ED25519_SPKI_PREFIX, "hex"), Buffer.from(raw32)]),
    format: "der",
    type: "spki",
  });
}

describe("@starkware-libs/anystark-react/testing entry", () => {
  // Export-surface lock for the `@starkware-libs/anystark-react/testing` subpath, mirroring the
  // `.`-entry lock in index.test.ts. Object.keys only sees runtime (value) exports;
  // an accidental add/remove on the public testing surface fails here.
  it("exposes exactly the expected public value exports", () => {
    expect(Object.keys(testing).sort()).toEqual([
      "MOCK_PHANTOM_PUBKEY",
      "MockPhantomConnector",
      "MockPhantomProvider",
      "installMockPhantom",
    ]);
  });
});

describe("MockPhantomProvider", () => {
  it("exposes the repo's canonical deterministic test public key", () => {
    expect(MOCK_PHANTOM_PUBKEY).toEqual(LOCKED_PUBKEY);
    const provider = new MockPhantomProvider();
    expect(provider.publicKey).toBeNull(); // not connected yet
    expect(provider.isPhantom).toBe(true);
  });

  it("connect() marks it connected and returns the public key", async () => {
    const provider = new MockPhantomProvider();
    const { publicKey } = await provider.connect();
    expect(publicKey.toBytes()).toEqual(MOCK_PHANTOM_PUBKEY);
    expect(provider.publicKey?.toBytes()).toEqual(MOCK_PHANTOM_PUBKEY);
    await provider.disconnect();
    expect(provider.publicKey).toBeNull();
  });

  it("signMessage() produces a deterministic, valid Ed25519 signature over the given bytes", async () => {
    const provider = new MockPhantomProvider();
    const message = new TextEncoder().encode("any bytes, hex, base64, whatever");

    const { signature } = await provider.signMessage(message);
    expect(signature).toHaveLength(64);

    // Deterministic: same bytes -> same signature.
    const { signature: again } = await provider.signMessage(message);
    expect(again).toEqual(signature);

    // Valid Ed25519 over exactly those bytes, verifiable against the public key.
    const pubkey = ed25519PublicKey(MOCK_PHANTOM_PUBKEY);
    expect(ed25519Verify(null, message, pubkey, signature)).toBe(true);
  });

  it("signs the locked @starkware-libs/anystark-core vector byte-for-byte (crypto-swap guard)", async () => {
    // Signing the exact input the locked vector fixes must yield the exact locked
    // bytes; a signer or crypto-lib swap that alters the output trips this.
    const provider = new MockPhantomProvider();
    const message = new TextEncoder().encode(LOCKED_HASH_TEXT);
    const { signature } = await provider.signMessage(message);
    expect(signature).toEqual(LOCKED_SIG64);
  });

  it("is scheme-agnostic: it signs whatever bytes it is handed, not a fixed message", async () => {
    // The mock never constructs the message format, so it signs both a hex-text
    // payload and a base64-text payload equally; the exact bytes decide the sig.
    // (The real encoding is chosen upstream in @starkware-libs/anystark-core's signRaw, not here.)
    const provider = new MockPhantomProvider();
    const pubkey = ed25519PublicKey(MOCK_PHANTOM_PUBKEY);

    const hexForm = new TextEncoder().encode("0x" + "ab".repeat(32));
    const base64Form = new TextEncoder().encode("qrsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");

    const hexSig = (await provider.signMessage(hexForm)).signature;
    const base64Sig = (await provider.signMessage(base64Form)).signature;

    expect(ed25519Verify(null, hexForm, pubkey, hexSig)).toBe(true);
    expect(ed25519Verify(null, base64Form, pubkey, base64Sig)).toBe(true);
    // Different bytes -> different signatures (the mock did not hardcode either).
    expect(base64Sig).not.toEqual(hexSig);
  });

  it("matches the exact signBytes seam the connector consumes (via PhantomProviderWrapper)", async () => {
    const provider = new MockPhantomProvider();
    const message = new TextEncoder().encode("bound to the wrapper seam");
    const direct = (await provider.signMessage(message)).signature;
    // PhantomProviderWrapper.signBytes is what SolanaAsStarknetSigner.signRaw calls.
    const viaWrapper = await new PhantomProviderWrapper(provider).signBytes(message);
    expect(viaWrapper).toEqual(direct);
  });

  it("signAndSendTransaction rejects (the CCTP Solana path is not mocked)", async () => {
    const provider = new MockPhantomProvider();
    await expect(provider.signAndSendTransaction()).rejects.toThrow(/signAndSendTransaction/);
  });

  it("on/removeListener register, emit, and remove round-trip", () => {
    const provider = new MockPhantomProvider();
    const calls: unknown[][] = [];
    const handler = (...args: unknown[]) => calls.push(args);

    provider.on("accountChanged", handler);
    provider.emit("accountChanged", "first");
    expect(calls).toEqual([["first"]]);

    provider.removeListener("accountChanged", handler);
    provider.emit("accountChanged", "second");
    // Still just the first call; the removed handler is not invoked again.
    expect(calls).toEqual([["first"]]);
  });
});

describe("MockPhantomConnector", () => {
  it("connects with no browser and no globals, exposing the derived account + chainId", async () => {
    const connector = new MockPhantomConnector(config);
    expect(connector.available()).toBe(true);

    const { account, chainId } = await connector.connect();
    expect(chainId).toBe(BigInt(CHAIN_IDS.sepolia));

    // The derived address is a pure function of the mock's public key; it plugs
    // into the same derivation path production uses.
    const derived = deriveSolAccountAddress(MOCK_PHANTOM_PUBKEY, resolveDeployClassHash(config));
    expect(account).toBe(derived.address);
    expect(account).toBe(MOCK_SEPOLIA_ADDRESS);
  });

  it("account() returns a starknet.js Account at the derived address", async () => {
    const connector = new MockPhantomConnector(config);
    await connector.connect();
    const account = await connector.account();
    expect(account.address).toBe(MOCK_SEPOLIA_ADDRESS);
  });

  it("connect() is idempotent: a second connect returns the same account + chainId", async () => {
    const connector = new MockPhantomConnector(config);
    const first = await connector.connect();
    const second = await connector.connect();
    expect(second.account).toBe(first.account);
    expect(second.chainId).toBe(first.chainId);
  });

  it("disconnect() clears state", async () => {
    const connector = new MockPhantomConnector(config);
    await connector.connect();
    await connector.disconnect();
    await expect(connector.account()).rejects.toThrow(/not connected/);
  });

  it("accepts a caller-provided MockPhantomProvider instance", async () => {
    const provider = new MockPhantomProvider();
    const connector = new MockPhantomConnector(config, provider);
    expect(connector.mockProvider).toBe(provider);
    const { account } = await connector.connect();
    expect(account).toBe(MOCK_SEPOLIA_ADDRESS);
  });

  it("throws when constructed without chainId, keeping the test offline", () => {
    // Structural offline guarantee: without chainId the base connector would fall
    // back to a live getChainId() RPC, so construction fails fast instead.
    expect(
      () =>
        new MockPhantomConnector({
          starknetRpcUrl: "http://localhost:5050",
          paymaster: { nodeUrl: "http://paymaster.localhost" },
        }),
    ).toThrow(/chainId/);
  });
});

describe("PhantomConnector detectProvider seam", () => {
  it("available() is false when detectProvider() returns null", () => {
    // A subclass whose seam yields no provider models "Phantom not installed".
    class NoProviderConnector extends PhantomConnector {
      protected override detectProvider(): PhantomProviderWrapper | null {
        return null;
      }
    }
    expect(new NoProviderConnector(config).available()).toBe(false);
  });
});

describe("installMockPhantom", () => {
  const globalTarget = globalThis as { window?: unknown };

  afterEach(() => {
    // Guard against a leaked window from a failed assertion in any branch.
    delete globalTarget.window;
  });

  it("lets a plain PhantomConnector discover the wallet via the global window", () => {
    // Branch: there was NO prior window.
    expect("window" in globalTarget).toBe(false);
    const { uninstall } = installMockPhantom();

    expect(new PhantomConnector(config).available()).toBe(true);

    uninstall();
    // Prior state restored: window is gone again.
    expect("window" in globalTarget).toBe(false);
  });

  it("uninstall() restores a pre-existing window, preserving its other properties", () => {
    // Branch: there WAS a prior window (with unrelated state to preserve).
    const priorWindow = { existingKey: "keep-me" };
    globalTarget.window = priorWindow;
    expect("window" in globalTarget).toBe(true);

    const { uninstall } = installMockPhantom();
    // The install is surgical: it added `phantom` to the SAME window object.
    expect(globalTarget.window).toBe(priorWindow);
    expect((globalTarget.window as { phantom?: unknown }).phantom).toBeDefined();

    uninstall();
    // Prior state restored: window still present, its own key intact, phantom gone.
    expect("window" in globalTarget).toBe(true);
    expect(globalTarget.window).toBe(priorWindow);
    expect(priorWindow).toEqual({ existingKey: "keep-me" });
  });
});
