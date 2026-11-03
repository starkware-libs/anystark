import { afterEach, describe, expect, it } from "vitest";
import {
  PhantomProviderWrapper,
  getPhantomProvider,
  type PhantomConnection,
  type PhantomProvider,
} from "./provider";

const PUBKEY = Uint8Array.from([1, 2, 3]);
const ADDRESS = "SoLanaAddr111";
// A second identity, used to prove event payloads flow through rather than the
// provider's own publicKey being read back.
const OTHER_PUBKEY = Uint8Array.from([4, 5, 6]);
const OTHER_ADDRESS = "OtherAddr222";
const otherKey = { toBytes: () => OTHER_PUBKEY, toString: () => OTHER_ADDRESS };

type EventHandler = (...args: unknown[]) => void;

/** Captures the handlers a wrapper registers via `on`, the handlers it later
 *  hands to `removeListener`, and lets a test synthetically fire an event. */
interface EventRegistry {
  handlers: Record<string, EventHandler[]>;
  removedListeners: Array<{ event: string; handler: EventHandler }>;
  emit(event: string, ...args: unknown[]): void;
}

function mockProvider(overrides: Partial<PhantomProvider> = {}): PhantomProvider & {
  events: EventRegistry;
} {
  const publicKey = { toBytes: () => PUBKEY, toString: () => ADDRESS };
  const events: EventRegistry = {
    handlers: {},
    removedListeners: [],
    emit(event, ...args) {
      (events.handlers[event] ?? []).forEach((handler) => handler(...args));
    },
  };
  const provider: PhantomProvider = {
    isPhantom: true,
    publicKey,
    connect: async () => ({ publicKey }),
    disconnect: async () => {},
    signMessage: async () => ({ signature: Uint8Array.from([9, 9]), publicKey }),
    signAndSendTransaction: async () => ({ signature: "txsig" }),
    on: (event, handler) => {
      (events.handlers[event] ??= []).push(handler);
    },
    removeListener: (event, handler) => {
      events.removedListeners.push({ event, handler });
      // Actually detach the handler so an emit-after-unsubscribe can't silently
      // pass against a SUT that forgot to remove it.
      const eventHandlers = events.handlers[event] ?? [];
      const handlerIndex = eventHandlers.indexOf(handler);
      if (handlerIndex !== -1) eventHandlers.splice(handlerIndex, 1);
    },
    ...overrides,
  };
  return { ...provider, events };
}

function setWindowProvider(p: PhantomProvider | undefined) {
  (globalThis as unknown as { window?: unknown }).window = p ? { phantom: { solana: p } } : {};
}

// Place a provider on the legacy window.solana injection point (no window.phantom).
function setLegacyWindowProvider(p: PhantomProvider) {
  (globalThis as unknown as { window?: unknown }).window = { solana: p };
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe("getPhantomProvider", () => {
  it("returns null when there is no window / no Phantom", () => {
    expect(getPhantomProvider()).toBeNull();
    setWindowProvider(undefined);
    expect(getPhantomProvider()).toBeNull();
  });

  it("ignores a non-Phantom injected provider", () => {
    setWindowProvider(mockProvider({ isPhantom: false }));
    expect(getPhantomProvider()).toBeNull();
  });

  it("finds the injected Phantom provider", () => {
    setWindowProvider(mockProvider());
    expect(getPhantomProvider()).not.toBeNull();
  });

  it("falls back to the legacy window.solana injection point", () => {
    setLegacyWindowProvider(mockProvider());
    expect(getPhantomProvider()).not.toBeNull();
  });

  it("rejects a non-Phantom provider on legacy window.solana", () => {
    setLegacyWindowProvider(mockProvider({ isPhantom: false }));
    expect(getPhantomProvider()).toBeNull();
  });
});

describe("PhantomProviderWrapper", () => {
  it("connect returns the raw pubkey + base58 address", async () => {
    const wrapper = new PhantomProviderWrapper(mockProvider());
    expect(await wrapper.connect()).toEqual({ pubkey: PUBKEY, address: ADDRESS });
  });

  it("signBytes returns the provider's signature unchanged (and is bound)", async () => {
    const wrapper = new PhantomProviderWrapper(mockProvider());
    const { signBytes } = wrapper; // destructured → must stay bound
    expect(await signBytes(new Uint8Array([1]))).toEqual(Uint8Array.from([9, 9]));
  });

  it("signAndSendTransaction returns the base58 tx signature", async () => {
    const wrapper = new PhantomProviderWrapper(mockProvider());
    expect(await wrapper.signAndSendTransaction({})).toBe("txsig");
  });

  describe("disconnect", () => {
    it("delegates to the provider and swallows a rejecting disconnect", async () => {
      let disconnectCalled = false;
      const wrapper = new PhantomProviderWrapper(
        mockProvider({
          disconnect: async () => {
            disconnectCalled = true;
            throw new Error("provider disconnect blew up");
          },
        }),
      );
      await expect(wrapper.disconnect()).resolves.toBeUndefined();
      expect(disconnectCalled).toBe(true);
    });
  });

  describe("current", () => {
    it("returns the connected identity when provider.publicKey is set", () => {
      const wrapper = new PhantomProviderWrapper(mockProvider());
      expect(wrapper.current()).toEqual({ pubkey: PUBKEY, address: ADDRESS });
    });

    it("returns null when provider.publicKey is null", () => {
      const wrapper = new PhantomProviderWrapper(mockProvider({ publicKey: null }));
      expect(wrapper.current()).toBeNull();
    });
  });

  describe("subscribe", () => {
    it("registers exactly one connect/disconnect/accountChanged listener", () => {
      const provider = mockProvider();
      new PhantomProviderWrapper(provider).subscribe({});
      expect(Object.keys(provider.events.handlers).sort()).toEqual([
        "accountChanged",
        "connect",
        "disconnect",
      ]);
      expect(provider.events.handlers.connect).toHaveLength(1);
      expect(provider.events.handlers.disconnect).toHaveLength(1);
      expect(provider.events.handlers.accountChanged).toHaveLength(1);
    });

    it("maps a connect event carrying a PublicKey to a PhantomConnection", () => {
      const provider = mockProvider();
      let connection: PhantomConnection | null | undefined;
      new PhantomProviderWrapper(provider).subscribe({ onConnect: (c) => (connection = c) });
      provider.events.emit("connect", otherKey);
      expect(connection).toEqual({ pubkey: OTHER_PUBKEY, address: OTHER_ADDRESS });
    });

    it("falls back to provider.publicKey when connect fires with no argument", () => {
      const provider = mockProvider();
      let connection: PhantomConnection | null | undefined;
      new PhantomProviderWrapper(provider).subscribe({ onConnect: (c) => (connection = c) });
      provider.events.emit("connect");
      expect(connection).toEqual({ pubkey: PUBKEY, address: ADDRESS });
    });

    it("invokes onDisconnect when a disconnect event fires", () => {
      const provider = mockProvider();
      let onDisconnectCalled = false;
      new PhantomProviderWrapper(provider).subscribe({
        onDisconnect: () => (onDisconnectCalled = true),
      });
      provider.events.emit("disconnect");
      expect(onDisconnectCalled).toBe(true);
    });

    it("yields null for an accountChanged event with no argument (no publicKey fallback)", () => {
      const provider = mockProvider();
      let onAccountChangedCalled = false;
      let connection: PhantomConnection | null | undefined;
      new PhantomProviderWrapper(provider).subscribe({
        onAccountChanged: (c) => {
          onAccountChangedCalled = true;
          connection = c;
        },
      });
      provider.events.emit("accountChanged");
      expect(onAccountChangedCalled).toBe(true);
      expect(connection).toBeNull();
    });

    it("unsubscribe removes the exact same handler references it registered", () => {
      const provider = mockProvider();
      const unsubscribe = new PhantomProviderWrapper(provider).subscribe({});
      const eventNames = ["connect", "disconnect", "accountChanged"];
      // Capture the registered handler refs before unsubscribe detaches them.
      const registeredHandlers = eventNames.map((event) => provider.events.handlers[event][0]);
      unsubscribe();
      eventNames.forEach((event, index) => {
        const removedListeners = provider.events.removedListeners
          .filter((entry) => entry.event === event)
          .map((entry) => entry.handler);
        expect(removedListeners).toEqual([registeredHandlers[index]]);
        expect(provider.events.handlers[event]).toHaveLength(0);
      });
    });

    it("unsubscribe is a no-op when the provider has no removeListener", () => {
      const wrapper = new PhantomProviderWrapper(mockProvider({ removeListener: undefined }));
      const unsubscribe = wrapper.subscribe({});
      expect(() => unsubscribe()).not.toThrow();
    });
  });

  describe("asSigner", () => {
    it("mints a SolanaSigner that carries the connection pubkey and signs", async () => {
      const wrapper = new PhantomProviderWrapper(mockProvider());
      const connection = await wrapper.connect();
      const signer = wrapper.asSigner(connection);

      expect(signer.pubkey).toBe(PUBKEY);
      expect(await signer.signBytes(new Uint8Array([1]))).toEqual(Uint8Array.from([9, 9]));
    });

    it("pins the pubkey from the passed connection, not the live provider", () => {
      const wrapper = new PhantomProviderWrapper(mockProvider());
      const pinned = Uint8Array.from([7, 7, 7]);
      const signer = wrapper.asSigner({ pubkey: pinned, address: "other" });
      expect(signer.pubkey).toBe(pinned);
    });
  });
});
