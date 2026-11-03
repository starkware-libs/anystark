// PUBLIC E2E: the no-secret mainnet mirror of sepolia.public.e2e.test.ts.
//
// Unlike the sepolia public tier (DEFAULT-ON), this suite is OPT-IN (default-OFF): it
// runs only when EWC_E2E_MAINNET=1. That is deliberate - the pinned class must be
// declared on mainnet before its on-chain check can pass, and mainnet goes live after
// sepolia, so a default-on mainnet check would red every `npm test`/CI run until the
// declaration lands. Enable it once the class is declared on mainnet to validate the
// same fund-safety invariants there (declared class hash, address derivation, endpoint).
//
// Everything here needs only a PUBLIC read-only mainnet RPC: no signing, no funds, no
// secrets. The class hash is network-independent, so the locked vector derives to the
// SAME address as on sepolia.
//
// Environment:
//   EWC_E2E_MAINNET=1            Opt IN - run this suite (default: skipped).
//   EWC_E2E_MAINNET_RPC_URL      Override the default public mainnet RPC.
//
// Run just this suite: `EWC_E2E_MAINNET=1 npm run test:e2e:mainnet:public -w @starkware-libs/anystark-react`.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RpcProvider } from "starknet";
import {
  CHAIN_IDS,
  deriveSolAccountAddress,
  resolveDeployClassHash,
} from "@starkware-libs/anystark-core";
import { PhantomConnector } from "./connector";
import { installPhantom } from "./sepolia.e2e.helpers";

// Opt-IN switch (read once, at module load). Default OFF.
const RUN_MAINNET = process.env.EWC_E2E_MAINNET === "1";
// A public mainnet RPC matching this repo's starknet.js RPC spec. Overridable so a CI
// runner can point at its own (rate-limit-friendly) endpoint via EWC_E2E_MAINNET_RPC_URL.
const RPC_URL =
  process.env.EWC_E2E_MAINNET_RPC_URL ?? "https://api.cartridge.gg/x/starknet/mainnet";

// The locked derivation vector. Because the class hash is network-independent, the same
// public pubkey derives the SAME address on mainnet as on sepolia; this is the identical
// literal pinned in packages/core/src/key_to_address.test.ts and the sepolia public e2e.
const LOCKED_VECTOR_PUBKEY = Uint8Array.from(
  Array.from({ length: 32 }, (_, byteIndex) => byteIndex),
);
const LOCKED_VECTOR_ADDRESS = "0x3011dc8056908306c2c0fbf47a0d470318e1871323311951eff05d333bfc7b7";

describe.skipIf(!RUN_MAINNET)("mainnet public e2e", { retry: 2, timeout: 60_000 }, () => {
  let provider: RpcProvider;

  beforeAll(() => {
    provider = new RpcProvider({ nodeUrl: RPC_URL });
    installPhantom(LOCKED_VECTOR_PUBKEY);
  });

  afterAll(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("connects to a mainnet RPC", async () => {
    expect(await provider.getChainId()).toBe(CHAIN_IDS.mainnet);
  });

  it("resolves the deploy class hash and finds it declared on-chain", async () => {
    const classHash = resolveDeployClassHash({ chainId: CHAIN_IDS.mainnet });
    // getClass throws if the class is not declared - the SDK is unusable on a network
    // where the pinned class is missing, so this is the core fund-safety smoke test.
    await expect(provider.getClass(classHash)).resolves.toBeDefined();
  });

  it("derives the locked-vector address through both the SDK and the connector", async () => {
    const classHash = resolveDeployClassHash({ chainId: CHAIN_IDS.mainnet });

    expect(BigInt(deriveSolAccountAddress(LOCKED_VECTOR_PUBKEY, classHash).address)).toBe(
      BigInt(LOCKED_VECTOR_ADDRESS),
    );

    const connector = new PhantomConnector({
      starknetRpcUrl: RPC_URL,
      chainId: CHAIN_IDS.mainnet,
      // A paymaster is required to construct the account; this suite only derives an
      // address (connect + account, nothing signed or executed), so it is never contacted.
      paymaster: { nodeUrl: "http://paymaster.localhost" },
    });
    await connector.connect();
    const account = await connector.account();
    expect(BigInt(account.address)).toBe(BigInt(LOCKED_VECTOR_ADDRESS));
  });
});
