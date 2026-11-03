import { afterEach, describe, expect, it, vi } from "vitest";
import { Account, RpcProvider, constants, type ProviderInterface } from "starknet";
import { CHAIN_IDS, LabeledExecutor, SolanaAsStarknetAccount } from "@starkware-libs/anystark-core";
import { PhantomConnector } from "./connector";

const PUBKEY = Uint8Array.from(Array.from({ length: 32 }, (_, i) => i));
const EXPECTED_ADDRESS = "0x3011dc8056908306c2c0fbf47a0d470318e1871323311951eff05d333bfc7b7";

function setPhantom(present: boolean) {
  const publicKey = { toBytes: () => PUBKEY, toString: () => "SoLAddr" };
  const provider = {
    isPhantom: true,
    publicKey,
    connect: async () => ({ publicKey }),
    disconnect: async () => {},
    signMessage: async () => ({ signature: new Uint8Array(64), publicKey }),
    signAndSendTransaction: async () => ({ signature: "s" }),
    on: () => {},
    removeListener: () => {},
  };
  (globalThis as unknown as { window?: unknown }).window = present
    ? { phantom: { solana: provider } }
    : {};
}

// Every account executes sponsored, so a paymaster is always part of the config.
const config = {
  starknetRpcUrl: "http://localhost:5050",
  chainId: CHAIN_IDS.sepolia,
  paymaster: { nodeUrl: "http://paymaster.localhost" },
};

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe("PhantomConnector", () => {
  it("has stable id/name and reflects Phantom availability", () => {
    const c = new PhantomConnector(config);
    expect(c.id).toBe("phantomEwc");
    expect(c.name).toBe("Phantom");
    setPhantom(false);
    expect(c.available()).toBe(false);
    setPhantom(true);
    expect(c.available()).toBe(true);
  });

  it("connect returns the derived account address + configured chainId", async () => {
    setPhantom(true);
    const c = new PhantomConnector(config);
    const data = await c.connect();
    expect(data.account).toBe(EXPECTED_ADDRESS);
    expect(data.chainId).toBe(BigInt(CHAIN_IDS.sepolia));
  });

  it("account() returns a starknet.js Account at the derived address", async () => {
    setPhantom(true);
    const c = new PhantomConnector(config);
    await c.connect();
    const account = await c.account();
    expect(account).toBeInstanceOf(Account);
    expect(account.address).toBe(EXPECTED_ADDRESS);
  });

  it("connect throws a clear error when Phantom is absent", async () => {
    setPhantom(false);
    await expect(new PhantomConnector(config).connect()).rejects.toThrow(/Phantom not found/);
  });

  it("disconnect clears state, calls provider.disconnect(), and emits disconnect", async () => {
    setPhantom(true);
    const c = new PhantomConnector(config);
    await c.connect();
    let emitted = false;
    c.on("disconnect", () => {
      emitted = true;
    });
    await c.disconnect();
    expect(emitted).toBe(true);
    // State is cleared: account() now reports not-connected.
    await expect(c.account()).rejects.toThrow(/not connected/);
  });

  it("ready() returns true when Phantom silently restores trust", async () => {
    setPhantom(true);
    const c = new PhantomConnector(config);
    expect(await c.ready()).toBe(true);
  });

  it("ready() returns false when Phantom is absent", async () => {
    setPhantom(false);
    const c = new PhantomConnector(config);
    expect(await c.ready()).toBe(false);
  });

  it("chainId() falls back to a single getChainId() RPC and caches it when config.chainId is omitted", async () => {
    setPhantom(true);
    const getChainIdSpy = vi
      .spyOn(RpcProvider.prototype, "getChainId")
      .mockResolvedValue(constants.StarknetChainId.SN_SEPOLIA);
    try {
      const c = new PhantomConnector({
        starknetRpcUrl: "http://localhost:5050",
        paymaster: { nodeUrl: "http://paymaster.localhost" },
      });
      const first = await c.chainId();
      const second = await c.chainId();
      expect(first).toBe(BigInt(CHAIN_IDS.sepolia));
      expect(second).toBe(first);
      expect(getChainIdSpy).toHaveBeenCalledTimes(1); // memoized: only one RPC round-trip
    } finally {
      getChainIdSpy.mockRestore();
    }
  });

  it("account(provider) accepts the framework ProviderInterface and rejects a network mismatch", async () => {
    setPhantom(true);
    const c = new PhantomConnector(config);
    await c.connect();
    // Matching chainId: account() returns the account.
    const matching = { getChainId: async () => CHAIN_IDS.sepolia } as unknown as ProviderInterface;
    const account = await c.account(matching);
    expect(account.address).toBe(EXPECTED_ADDRESS);
    // Disagreeing chainId: account() throws rather than silently reading the wrong RPC.
    const mismatch = { getChainId: async () => CHAIN_IDS.mainnet } as unknown as ProviderInterface;
    await expect(c.account(mismatch)).rejects.toThrow(/disagrees/);
  });

  it("request() throws an explanatory not-implemented error", async () => {
    setPhantom(true);
    const c = new PhantomConnector(config);
    await expect(c.request({ type: "wallet_requestAccounts" } as never)).rejects.toThrow(
      /does not implement the wallet request API/,
    );
  });

  it("passes the paymaster config through to the created account", async () => {
    setPhantom(true);
    const paymaster = { nodeUrl: "http://paymaster.localhost" };
    const c = new PhantomConnector({ ...config, paymaster });
    await c.connect();
    const account = (await c.account()) as SolanaAsStarknetAccount;
    expect(account.paymasterConfig).toEqual(paymaster);
  });

  it("passes a LabeledExecutor instance to the signer by reference, without resolving it", async () => {
    setPhantom(true);
    const labeledExecutor = new LabeledExecutor("MyApp");
    const resolveSpy = vi.spyOn(labeledExecutor, "resolve");
    const c = new PhantomConnector({ ...config, signingLabel: labeledExecutor });
    await c.connect();
    const account = (await c.account()) as SolanaAsStarknetAccount;
    // The same reference reaches the signer, and nothing resolves it before a signature.
    expect((account.signer as unknown as { signingLabel: unknown }).signingLabel).toBe(
      labeledExecutor,
    );
    expect(resolveSpy).not.toHaveBeenCalled();
  });
});
