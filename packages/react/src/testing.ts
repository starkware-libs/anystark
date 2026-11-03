// @starkware-libs/anystark-react/testing: consumer test double.
// A deterministic, browser-free stand-in for the Phantom browser extension so a
// dapp can drive the full PhantomConnector connect + sign flow in unit tests
// (Vitest/Jest) with no extension installed and no browser globals.
//
// SCHEME-AGNOSTIC BY CONSTRUCTION: the mock Ed25519-signs exactly the bytes it is
// handed in `signMessage`, and never constructs or inspects the message format.
// The signed-message encoding is formed upstream in @starkware-libs/anystark-core's
// SolanaAsStarknetSigner.signRaw (which builds it via assembleSignedMessage), so this
// mock is unaffected by how that encoding is chosen.
//
// This module is a SEPARATE package entry (`@starkware-libs/anystark-react/testing`) so none of it
// lands in the main `@starkware-libs/anystark-react` runtime bundle.

import {
  createPrivateKey,
  createPublicKey,
  sign as ed25519Sign,
  type KeyObject,
} from "node:crypto";
import {
  PhantomProviderWrapper,
  type PhantomConnectorConfig,
  type PhantomProvider,
} from "@starkware-libs/anystark-core";
import { PhantomConnector } from "./connector";

// The repo's canonical deterministic test wallet: an Ed25519 key whose seed is the
// bytes 0..31. This is the same key behind @starkware-libs/anystark-core's locked test vectors
// (LOCKED_PUBKEY / LOCKED_SIG64 in test_vectors.ts), so the mock's public key and
// signatures line up with the values the SDK's own tests pin.
const TEST_SEED = Uint8Array.from({ length: 32 }, (_, index) => index);
// PKCS8 DER prefix that wraps a raw 32-byte Ed25519 seed into an importable key.
const ED25519_PKCS8_PREFIX = "302e020100300506032b657004220420";

function loadTestPrivateKey(): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([Buffer.from(ED25519_PKCS8_PREFIX, "hex"), Buffer.from(TEST_SEED)]),
    format: "der",
    type: "pkcs8",
  });
}

// Raw 32-byte Ed25519 public key = the trailing 32 bytes of the SPKI DER encoding.
function derivePublicKeyBytes(privateKey: KeyObject): Uint8Array {
  const spkiDer = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return new Uint8Array(spkiDer.subarray(spkiDer.length - 32));
}

const TEST_PRIVATE_KEY = loadTestPrivateKey();

/**
 * The deterministic 32-byte Ed25519 public key the mock wallet exposes. It is
 * byte-identical to @starkware-libs/anystark-core's locked test vector `LOCKED_PUBKEY` (both derive
 * from the seed-0..31 key), so the mock's identity and signatures line up with the
 * values the SDK's own tests pin.
 */
export const MOCK_PHANTOM_PUBKEY: Uint8Array = derivePublicKeyBytes(TEST_PRIVATE_KEY);

// A stable object matching Phantom's injected `publicKey` shape (toBytes/toString).
type MockPublicKey = { toBytes(): Uint8Array; toString(): string };

/**
 * In-memory implementation of the injected `window.phantom.solana` provider,
 * backed by the deterministic test keypair (seed 0..31). Drop-in for the real
 * Phantom extension in tests.
 *
 * `signMessage` Ed25519-signs the exact `message` bytes it is given and returns
 * the 64-byte signature; it does NOT build or assume any message encoding, so it
 * stays correct regardless of how the signed message is encoded upstream.
 */
export class MockPhantomProvider implements PhantomProvider {
  readonly isPhantom = true;

  private connected = false;
  private readonly handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  private readonly publicKeyObject: MockPublicKey = {
    toBytes: () => MOCK_PHANTOM_PUBKEY,
    // The base58 address is irrelevant to the sol_account flow; a stable
    // placeholder is enough for tests.
    toString: () => "MockPhantomTestWallet1111111111111111111111",
  };

  get publicKey(): MockPublicKey | null {
    return this.connected ? this.publicKeyObject : null;
  }

  async connect(): Promise<{ publicKey: MockPublicKey }> {
    this.connected = true;
    return { publicKey: this.publicKeyObject };
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async signMessage(
    message: Uint8Array,
  ): Promise<{ signature: Uint8Array; publicKey: MockPublicKey }> {
    // Sign whatever bytes we're handed, never construct or assume the encoding.
    const signature = new Uint8Array(ed25519Sign(null, message, TEST_PRIVATE_KEY));
    return { signature, publicKey: this.publicKeyObject };
  }

  async signAndSendTransaction(): Promise<{ signature: string }> {
    throw new Error(
      "MockPhantomProvider does not implement Solana signAndSendTransaction (CCTP path).",
    );
  }

  on(event: string, handler: (...args: unknown[]) => void): void {
    let handlerSet = this.handlers.get(event);
    if (!handlerSet) {
      handlerSet = new Set();
      this.handlers.set(event, handlerSet);
    }
    handlerSet.add(handler);
  }

  removeListener(event: string, handler: (...args: unknown[]) => void): void {
    this.handlers.get(event)?.delete(handler);
  }

  /** Test-only: synchronously invoke every handler currently registered for
   *  `event`. Lets a test simulate Phantom's connect/disconnect/accountChanged
   *  events and exercise the on/removeListener subscription round-trip. Not part
   *  of the real injected provider surface. */
  emit(event: string, ...args: unknown[]): void {
    this.handlers.get(event)?.forEach((handler) => handler(...args));
  }
}

/**
 * A PhantomConnector wired to an in-memory MockPhantomProvider instead of the
 * browser extension. Construct it in a test and drive connect() / account() /
 * disconnect() exactly as production code would, with no window and no globals.
 *
 * `config.chainId` is REQUIRED: this mock is offline by construction. The base
 * connector resolves chainId() via a live getChainId() RPC when `chainId` is
 * absent, so omitting it would turn an ostensibly offline test into a network
 * call. The constructor throws instead of degrading silently.
 */
export class MockPhantomConnector extends PhantomConnector {
  /** The underlying mock provider, exposed so tests can inspect it. */
  readonly mockProvider: MockPhantomProvider;
  private readonly wrapper: PhantomProviderWrapper;

  constructor(
    config: PhantomConnectorConfig,
    mockProvider: MockPhantomProvider = new MockPhantomProvider(),
  ) {
    super(config);
    if (!config.chainId) {
      throw new Error(
        "MockPhantomConnector requires `config.chainId` so it stays fully offline; " +
          "without it the connector would make a live getChainId() RPC call during connect().",
      );
    }
    this.mockProvider = mockProvider;
    // `this.wrapper` is assigned here, AFTER super(), and detectProvider() below
    // returns it. INVARIANT: the base PhantomConnector constructor must not call
    // detectProvider() (it would observe an undefined wrapper); see the invariant
    // comment on PhantomConnector's constructor.
    this.wrapper = new PhantomProviderWrapper(mockProvider);
  }

  protected override detectProvider(): PhantomProviderWrapper | null {
    return this.wrapper;
  }
}

/**
 * Install a MockPhantomProvider at `window.phantom.solana` on `target` (defaults
 * to `globalThis`) so a plain PhantomConnector, which discovers the wallet by
 * reading the global `window`, finds it. Prefer MockPhantomConnector for explicit
 * injection; use this only to exercise the window-discovery path itself (e.g. a
 * connector's `available()`).
 *
 * Surgical by design: it sets ONLY `window.phantom` (creating a bare `window`
 * object first if none exists), leaving any other properties of an existing
 * `window` untouched. `uninstall()` restores only what it changed: the prior
 * `phantom` value (deleting the key if there was none), or the whole `window`
 * object if it created that. Returns the provider and that `uninstall()`.
 */
export function installMockPhantom(
  provider: MockPhantomProvider = new MockPhantomProvider(),
  target: { window?: { phantom?: unknown } } = globalThis as { window?: { phantom?: unknown } },
): { provider: MockPhantomProvider; uninstall: () => void } {
  const hadWindow = "window" in target && target.window !== undefined;
  if (!hadWindow) target.window = {};
  const windowObject = target.window as { phantom?: unknown };
  const hadPhantom = "phantom" in windowObject;
  const previousPhantom = windowObject.phantom;
  windowObject.phantom = { solana: provider };
  return {
    provider,
    uninstall: () => {
      if (!hadWindow) {
        delete target.window;
        return;
      }
      if (hadPhantom) windowObject.phantom = previousPhantom;
      else delete windowObject.phantom;
    },
  };
}
