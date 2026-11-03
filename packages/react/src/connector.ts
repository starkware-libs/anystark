// ─── PhantomConnector ───
// A @starknet-react/core Connector that adds Phantom alongside native Starknet
// wallets. A dapp drops it into its `connectors` list and everything (useAccount,
// useSendTransaction, the connect modal) works unchanged, with no Phantom-specific
// branching, because account() returns a SolanaAsStarknetAccount (a starknet.js Account
// subclass) that runs paymaster-sponsored and bundles the counterfactual deploy on
// first use.
//
// This is "option A". Reaching non-@starknet-react consumers (raw get-starknet,
// starknetkit) would mean a get-starknet StarknetWindowObject; see @starkware-libs/anystark-core's
// window-object.ts (option B). That same surface is what `request()` below would
// implement; for now it points there.

import { Connector } from "@starknet-react/core";
import {
  SolanaAsStarknetAccount,
  PhantomProviderWrapper,
  resolveDeployClassHash,
  type PhantomConnectorConfig,
} from "@starkware-libs/anystark-core";
import { RpcProvider, type AccountInterface, type ProviderInterface } from "starknet";
import type { RequestFnCall, RpcMessage, RpcTypeToMessageMap } from "@starknet-io/types-js";

// Minimal placeholder mark (Phantom purple). Swap for the official brand asset.
const PHANTOM_ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='12' fill='%23AB9FF2'/%3E%3C/svg%3E";

export class PhantomConnector extends Connector {
  private provider: PhantomProviderWrapper | null = null;
  private acct: SolanaAsStarknetAccount | null = null;
  /** Memoized chainId from the RPC-fallback path, so we hit getChainId() at most once. */
  private resolvedChainId: bigint | null = null;

  // INVARIANT: do NOT call detectProvider() from this constructor. Subclasses
  // (e.g. MockPhantomConnector in @starkware-libs/anystark-react/testing) override detectProvider() to
  // return a wrapper they assign AFTER super() returns; calling it here would
  // observe that field before it is set.
  constructor(private readonly config: PhantomConnectorConfig) {
    super();
  }

  get id(): string {
    return "phantomEwc";
  }

  get name(): string {
    return "Phantom";
  }

  get icon(): string {
    return PHANTOM_ICON;
  }

  /** Resolve the Phantom provider wrapper from the injected `window.phantom`, or
   *  null when Phantom isn't available. Seam for tests: MockPhantomConnector in
   *  `@starkware-libs/anystark-react/testing` overrides this to inject a deterministic in-memory
   *  provider, so the full connect + sign flow runs with no browser and no
   *  extension. Production behavior is unchanged. */
  protected detectProvider(): PhantomProviderWrapper | null {
    return PhantomProviderWrapper.detect();
  }

  available(): boolean {
    return this.detectProvider() !== null;
  }

  /** Already authorized? Silently restores trust without prompting, so autoConnect
   *  doesn't pop the Phantom dialog on every load. */
  async ready(): Promise<boolean> {
    const p = this.detectProvider();
    if (!p) return false;
    try {
      const { pubkey } = await p.connect({ onlyIfTrusted: true });
      return pubkey.length > 0;
    } catch {
      return false;
    }
  }

  async connect(): Promise<{ account: string; chainId: bigint }> {
    const provider = this.detectProvider();
    if (!provider) throw new Error("Phantom not found. Install it from phantom.com.");
    const conn = await provider.connect();
    this.provider = provider;
    this.acct = new SolanaAsStarknetAccount({
      signer: { pubkey: conn.pubkey, signBytes: provider.signBytes },
      rpcUrl: this.config.starknetRpcUrl,
      classHash: resolveDeployClassHash(this.config),
      paymaster: this.config.paymaster,
      signingLabel: this.config.signingLabel,
    });
    const chainId = await this.chainId();
    const data = { account: this.acct.address, chainId };
    this.emit("connect", data);
    return data;
  }

  async disconnect(): Promise<void> {
    await this.provider?.disconnect();
    this.provider = null;
    this.acct = null;
    this.emit("disconnect");
  }

  // The framework passes its StarknetConfig provider here, but the returned
  // SolanaAsStarknetAccount is intentionally pinned to config.starknetRpcUrl:
  // the counterfactual address derivation and the sponsored deploy-and-invoke on
  // first use all run against that RPC, so swapping it out mid-flight
  // would change the account's own view of itself. starknetRpcUrl is therefore
  // authoritative; the dapp should point its StarknetConfig at the same node.
  // We still accept the arg (matching the abstract account(provider, paymasterProvider?)
  // signature) and guard against a silent network mismatch.
  async account(provider?: ProviderInterface): Promise<AccountInterface> {
    if (!this.acct) throw new Error("PhantomConnector is not connected");
    if (provider) {
      const [own, theirs] = await Promise.all([this.chainId(), provider.getChainId()]);
      if (own !== BigInt(theirs)) {
        throw new Error(
          `PhantomConnector RPC (${this.config.starknetRpcUrl}, chainId ${own}) disagrees with the ` +
            `StarknetConfig provider (chainId ${BigInt(theirs)}). Point both at the same network.`,
        );
      }
    }
    return this.acct;
  }

  async chainId(): Promise<bigint> {
    if (this.config.chainId) return BigInt(this.config.chainId);
    if (this.resolvedChainId === null) {
      const rpc = new RpcProvider({ nodeUrl: this.config.starknetRpcUrl });
      this.resolvedChainId = BigInt(await rpc.getChainId());
    }
    return this.resolvedChainId;
  }

  async request<T extends RpcMessage["type"]>(
    call: RequestFnCall<T>,
  ): Promise<RpcTypeToMessageMap[T]["result"]> {
    throw new Error(
      `PhantomConnector does not implement the wallet request API (got "${call.type}"). ` +
        "Use the connected account (useSendTransaction / account.execute). Full wallet-request " +
        "support would be the StarknetWindowObject; see @starkware-libs/anystark-core window-object.ts (option B).",
    );
  }
}
