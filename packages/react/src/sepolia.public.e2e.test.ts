// PUBLIC E2E: the no-secret, DEFAULT-ON tier of the Sepolia journey.
//
// Unlike sepolia.live.e2e.test.ts (opt-in; real seed, funder, and paymaster; moves
// real funds), everything here needs only a PUBLIC read-only Sepolia RPC: no signing,
// no funds, no secrets. That lets it run automatically on every `npm test` (and in CI)
// as a real integration smoke test — it catches the highest-severity, fund-safety
// regressions (a wrong/undeclared class hash, a broken address derivation, a non-Sepolia
// endpoint) against the live chain, not a mock.
//
// TRADEOFF: because it hits a real network, it is DEFAULT-ON but OPT-OUT. It can fail for
// reasons outside this repo (public RPC down, rate-limited, or reorg'd). To absorb transient
// blips it uses `retry` and generous timeouts; to disable it entirely (e.g. an offline
// developer or an air-gapped CI) set EWC_E2E_SKIP_PUBLIC=1 and it self-skips.
//
// Environment:
//   EWC_E2E_SKIP_PUBLIC=1   Opt OUT — skip this whole suite (default: run it).
//   EWC_E2E_RPC_URL         Override the default public RPC (a Sepolia JSON-RPC URL).
//
// Run just this suite: `npm run test:e2e:sepolia:public -w @starkware-libs/anystark-react`.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RpcProvider } from "starknet";
import {
  CHAIN_IDS,
  deriveSolAccountAddress,
  resolveDeployClassHash,
} from "@starkware-libs/anystark-core";
import { PhantomConnector } from "./connector";
import { installPhantom } from "./sepolia.e2e.helpers";

// Opt-OUT switch (read once, at module load).
const SKIP_PUBLIC = process.env.EWC_E2E_SKIP_PUBLIC === "1";
// A public Sepolia RPC that matches this repo's starknet.js RPC spec (0.9.0). Overridable
// so a CI runner can point at its own (rate-limit-friendly) endpoint via EWC_E2E_RPC_URL.
const RPC_URL = process.env.EWC_E2E_RPC_URL ?? "https://api.zan.top/public/starknet-sepolia";

// The locked TS↔Cairo derivation vector (bytes 0..31 → this address, against the deploy
// class hash). A PUBLIC key material by design — bytes 0..31 is anyone's, and nothing here
// signs — so it is safe to derive with and compare on a public network. Mirrors the pins in
// packages/core/src/key_to_address.test.ts and sepolia.live.e2e.test.ts; keep them in lockstep.
const LOCKED_VECTOR_PUBKEY = Uint8Array.from(
  Array.from({ length: 32 }, (_, byteIndex) => byteIndex),
);
const LOCKED_VECTOR_ADDRESS = "0x3011dc8056908306c2c0fbf47a0d470318e1871323311951eff05d333bfc7b7";

describe.skipIf(SKIP_PUBLIC)("sepolia public e2e", { retry: 2, timeout: 60_000 }, () => {
  let provider: RpcProvider;

  beforeAll(() => {
    provider = new RpcProvider({ nodeUrl: RPC_URL });
    // Install a mock Phantom keyed to the public pubkey (no private key ⇒ it cannot sign,
    // which is correct: this tier never signs). PhantomConnector then runs unmodified.
    installPhantom(LOCKED_VECTOR_PUBKEY);
  });

  afterAll(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("connects to a Sepolia RPC", async () => {
    expect(await provider.getChainId()).toBe(CHAIN_IDS.sepolia);
  });

  it("resolves the deploy class hash and finds it declared on-chain", async () => {
    const classHash = resolveDeployClassHash({ chainId: CHAIN_IDS.sepolia });
    // getClass throws if the class is not declared — the whole SDK is unusable on a network
    // where the pinned class is missing, so this is the core fund-safety smoke test.
    await expect(provider.getClass(classHash)).resolves.toBeDefined();
  });

  it("derives the locked-vector address through both the SDK and the connector", async () => {
    const classHash = resolveDeployClassHash({ chainId: CHAIN_IDS.sepolia });

    // SDK path: the pinned literal address, recomputed from the public pubkey + class hash.
    expect(BigInt(deriveSolAccountAddress(LOCKED_VECTOR_PUBKEY, classHash).address)).toBe(
      BigInt(LOCKED_VECTOR_ADDRESS),
    );

    // Connector path: exactly what a dapp gets from connect() → account(). No network beyond
    // the config-supplied chainId, and nothing is signed.
    const connector = new PhantomConnector({
      starknetRpcUrl: RPC_URL,
      chainId: CHAIN_IDS.sepolia,
      // A paymaster is required to construct the account; this suite only derives an
      // address (connect + account, nothing signed or executed), so it is never contacted.
      paymaster: { nodeUrl: "http://paymaster.localhost" },
    });
    await connector.connect();
    const account = await connector.account();
    expect(BigInt(account.address)).toBe(BigInt(LOCKED_VECTOR_ADDRESS));
  });
});
