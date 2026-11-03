// ─── Phantom provider ───
// Framework-agnostic wrapper over Phantom's injected Solana provider
// (window.phantom.solana) — NO heavy SDK, just the injected EIP-1193-style
// object, so the main bundle stays lean. The React hook in @starkware-libs/anystark-react is a thin
// adapter over this; Solana tx-building libs (for CCTP) load lazily elsewhere.

import type { SolanaSigner, SignBytes } from "./signer";

interface PhantomPublicKey {
  toBytes(): Uint8Array;
  toString(): string;
}

/** The shape of the injected `window.phantom.solana` object we depend on. */
export interface PhantomProvider {
  isPhantom?: boolean;
  publicKey: PhantomPublicKey | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: PhantomPublicKey }>;
  disconnect(): Promise<void>;
  signMessage(
    message: Uint8Array,
    display?: "utf8" | "hex",
  ): Promise<{ signature: Uint8Array; publicKey: PhantomPublicKey }>;
  signAndSendTransaction(tx: unknown, opts?: unknown): Promise<{ signature: string }>;
  on(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

/** Locate the injected Phantom Solana provider, or null if not present. */
export function getPhantomProvider(): PhantomProvider | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    phantom?: { solana?: PhantomProvider };
    solana?: PhantomProvider;
  };
  // Prefer window.phantom.solana; fall back to window.solana, the legacy shared
  // injection point other wallets (Solflare/Backpack) also populate. The
  // isPhantom guard below rejects any non-Phantom provider found there.
  const p = w.phantom?.solana ?? w.solana;
  return p?.isPhantom ? p : null;
}

/** A connected Phantom identity: the raw 32-byte Ed25519 pubkey + base58 address. */
export interface PhantomConnection {
  pubkey: Uint8Array;
  address: string;
}

export interface PhantomSubscription {
  onConnect?(c: PhantomConnection | null): void;
  onDisconnect?(): void;
  onAccountChanged?(c: PhantomConnection | null): void;
}

/**
 * Vanilla wrapper over the injected Phantom provider. Exposes connect/disconnect,
 * a raw-bytes signer (`signBytes`, the SolanaSigner contract), Solana tx
 * broadcast (for CCTP), and event subscription. Construct via
 * `PhantomProviderWrapper.detect()`.
 */
export class PhantomProviderWrapper {
  constructor(private readonly provider: PhantomProvider) {}

  /** Wrap the injected provider, or null when Phantom isn't available. */
  static detect(): PhantomProviderWrapper | null {
    const p = getPhantomProvider();
    return p ? new PhantomProviderWrapper(p) : null;
  }

  /** Prompt (or silently restore with `onlyIfTrusted`) and return the identity. */
  async connect(opts?: { onlyIfTrusted?: boolean }): Promise<PhantomConnection> {
    const { publicKey } = await this.provider.connect(opts);
    return { pubkey: publicKey.toBytes(), address: publicKey.toString() };
  }

  async disconnect(): Promise<void> {
    await this.provider.disconnect().catch(() => {});
  }

  /** The currently-connected identity, or null. */
  current(): PhantomConnection | null {
    const pk = this.provider.publicKey;
    return pk ? { pubkey: pk.toBytes(), address: pk.toString() } : null;
  }

  /** Sign raw UTF-8 bytes; returns the 64-byte Ed25519 signature. Bound, so it
   *  can be handed directly to a SolanaSigner / SolanaAsStarknetSigner. */
  signBytes: SignBytes = async (message: Uint8Array) => {
    const { signature } = await this.provider.signMessage(message, "utf8");
    return signature;
  };

  /** Mint a SolanaSigner pinned to a specific connected identity: that
   *  connection's pubkey snapshot plus this provider's bound signBytes. Pass the
   *  PhantomConnection the sol_account address was derived from, so a later
   *  accountChanged can't silently re-point the signer to a different key. */
  asSigner(connection: PhantomConnection): SolanaSigner {
    return { pubkey: connection.pubkey, signBytes: this.signBytes };
  }

  /** Sign + broadcast a @solana/web3.js Transaction; returns the base58 sig.
   *  Any pre-attached partial signatures (e.g. a CCTP event keypair) are kept. */
  async signAndSendTransaction(tx: unknown): Promise<string> {
    const { signature } = await this.provider.signAndSendTransaction(tx);
    return signature;
  }

  /** Subscribe to connect/disconnect/accountChanged. Returns an unsubscribe fn. */
  subscribe(handlers: PhantomSubscription): () => void {
    const toConn = (pk: PhantomPublicKey | null): PhantomConnection | null =>
      pk ? { pubkey: pk.toBytes(), address: pk.toString() } : null;
    const onConnect = (...args: unknown[]) =>
      handlers.onConnect?.(toConn((args[0] as PhantomPublicKey | null) ?? this.provider.publicKey));
    const onDisconnect = () => handlers.onDisconnect?.();
    const onAccountChanged = (...args: unknown[]) =>
      handlers.onAccountChanged?.(toConn((args[0] as PhantomPublicKey | null) ?? null));

    this.provider.on("connect", onConnect);
    this.provider.on("disconnect", onDisconnect);
    this.provider.on("accountChanged", onAccountChanged);
    return () => {
      this.provider.removeListener?.("connect", onConnect);
      this.provider.removeListener?.("disconnect", onDisconnect);
      this.provider.removeListener?.("accountChanged", onAccountChanged);
    };
  }
}
