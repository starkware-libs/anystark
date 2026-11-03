import { describe, expect, it } from "vitest";
import { CCTP_MAINNET_ADDRESSES, CCTP_TESTNET_ADDRESSES } from "./addresses";
import { CctpBridge } from "./bridge";
import { CCTP_MAINNET_CONFIG, CCTP_TESTNET_CONFIG, type CctpConfig } from "./config";

// Config locks (fund-safety gate)
// Every value below is transcribed from Circle's published tables, cited in the doc
// comments on each config in ./config.ts. USDC minted to a wrong address is
// unrecoverable, and a burn pointed at the wrong attestation host silently never
// completes, so these literals are pinned as frozen values: a drift here means the
// package ships an address nobody verified. Re-verify against
// https://developers.circle.com/cctp before changing one.

const FELT = /^0x0[0-9a-fA-F]{62,63}$/;
const BASE58_PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Shape invariants that hold for every CctpConfig, testnet or mainnet. */
function itSatisfiesTheConfigContract(label: string, config: CctpConfig) {
  describe(`${label}: CctpConfig contract`, () => {
    it("carries an https Starknet RPC and attestation API", () => {
      expect(config.starknetRpcUrl).toMatch(/^https:\/\//);
      expect(config.attestationApi).toMatch(/^https:\/\//);
      // The bridge interpolates the base directly into `${base}/v2/messages/...`, so a
      // trailing slash would produce a double slash.
      expect(config.attestationApi.endsWith("/")).toBe(false);
    });

    it("names the Starknet contracts as well-formed, non-zero felts", () => {
      for (const address of [
        config.starknet.messageTransmitter,
        config.starknet.tokenMessenger,
        config.starknet.usdc,
      ]) {
        expect(address).toMatch(FELT);
        expect(BigInt(address)).toBeGreaterThan(0n);
      }
    });

    it("names distinct Starknet contracts (no copy-paste between the three)", () => {
      const felts = [
        config.starknet.messageTransmitter,
        config.starknet.tokenMessenger,
        config.starknet.usdc,
      ].map((a) => BigInt(a));
      expect(new Set(felts).size).toBe(3);
    });

    it("names the Solana programs and mint as base58 pubkeys", () => {
      expect(config.solana.rpcUrl).toMatch(/^https:\/\//);
      for (const address of [
        config.solana.messageTransmitter,
        config.solana.tokenMessengerMinter,
        config.solana.usdcMint,
      ]) {
        expect(address).toMatch(BASE58_PUBKEY);
      }
    });

    it("uses Circle's per-chain domain ids: Solana 5, Starknet 25", () => {
      // Domains are per-chain, not per-network, so both configs pin the same pair.
      expect(config.solana.domain).toBe(5);
      expect(config.starknet.domain).toBe(25);
    });

    it("builds calls against its own addresses", () => {
      const bridge = new CctpBridge(config);
      const calls = bridge.buildWithdrawToSolanaCalls(1_000_000n, new Uint8Array(32).fill(7));
      expect(BigInt(calls[0].contractAddress)).toBe(BigInt(config.starknet.usdc));
      expect(BigInt(calls[1].contractAddress)).toBe(BigInt(config.starknet.tokenMessenger));
      const receive = bridge.buildReceiveOnStarknetCall("0x1234", "0x5678");
      expect(BigInt(receive.contractAddress)).toBe(BigInt(config.starknet.messageTransmitter));
    });
  });
}

itSatisfiesTheConfigContract("CCTP_TESTNET_CONFIG", CCTP_TESTNET_CONFIG);
itSatisfiesTheConfigContract("CCTP_MAINNET_CONFIG", CCTP_MAINNET_CONFIG);

describe("CCTP_TESTNET_CONFIG (frozen literals)", () => {
  it("targets Solana devnet, Starknet Sepolia, and the SANDBOX attestation API", () => {
    expect(CCTP_TESTNET_CONFIG.attestationApi).toBe("https://iris-api-sandbox.circle.com");
    expect(CCTP_TESTNET_CONFIG.solana.rpcUrl).toBe("https://api.devnet.solana.com");
    expect(CCTP_TESTNET_CONFIG.starknetRpcUrl).toContain("sepolia");
  });

  it("pins Circle's Starknet Sepolia contracts", () => {
    expect(CCTP_TESTNET_CONFIG.starknet).toMatchObject({
      messageTransmitter: "0x04db7926C64f1f32a840F3Fa95cB551f3801a3600Bae87aF87807A54DCE12Fe8",
      tokenMessenger: "0x04bDdE1E09a4B09a2F95d893D94a967b7717eB85A3f6dEcA8c080Ee01fBc3370",
      usdc: "0x0512feAc6339Ff7889822cb5aA2a86C848e9D392bB0E3E237C008674feeD8343",
    });
  });

  it("pins the Solana devnet USDC mint", () => {
    expect(CCTP_TESTNET_CONFIG.solana.usdcMint).toBe(
      "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    );
  });
});

describe("CCTP_MAINNET_CONFIG (frozen literals)", () => {
  it("targets Solana mainnet-beta, Starknet mainnet, and PRODUCTION Iris", () => {
    // The sandbox host only attests testnet burns: pointing a mainnet burn at it
    // means the attestation never completes and the USDC stays burned.
    expect(CCTP_MAINNET_CONFIG.attestationApi).toBe("https://iris-api.circle.com");
    expect(CCTP_MAINNET_CONFIG.attestationApi).not.toContain("sandbox");
    expect(CCTP_MAINNET_CONFIG.solana.rpcUrl).toBe("https://api.mainnet-beta.solana.com");
    expect(CCTP_MAINNET_CONFIG.starknetRpcUrl).toBe("https://api.cartridge.gg/x/starknet/mainnet");
    expect(CCTP_MAINNET_CONFIG.starknetRpcUrl).not.toContain("sepolia");
  });

  it("pins Circle's Starknet mainnet contracts", () => {
    // https://developers.circle.com/cctp/starknet-contracts — "Mainnet contract addresses".
    expect(CCTP_MAINNET_CONFIG.starknet).toMatchObject({
      domain: 25,
      messageTransmitter: "0x02EBB5777B6dD8B26ea11D68Fdf1D2c85cD2099335328Be845a28c77A8AEf183",
      tokenMessenger: "0x07d421B9cA8aA32DF259965cDA8ACb93F7599F69209A41872AE84638B2A20F2a",
      usdc: "0x033068F6539f8e6e6b131e6B2B814e6c34A5224bC66947c47DaB9dFeE93b35fb",
    });
  });

  it("pins Circle's Solana mainnet programs and the mainnet-beta USDC mint", () => {
    // https://developers.circle.com/cctp/solana-programs — "Mainnet program addresses".
    // https://developers.circle.com/stablecoins/usdc-contract-addresses — Solana row.
    expect(CCTP_MAINNET_CONFIG.solana).toMatchObject({
      domain: 5,
      messageTransmitter: "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC",
      tokenMessengerMinter: "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe",
      usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    });
  });

  it("shares the Solana V2 program ids with testnet but NOT the USDC mint", () => {
    // Circle deploys the V2 programs at the same ids on mainnet-beta and devnet, so a
    // matching program id is correct here — but a matching mint would mean the mainnet
    // config still points at devnet USDC.
    expect(CCTP_MAINNET_CONFIG.solana.messageTransmitter).toBe(
      CCTP_TESTNET_CONFIG.solana.messageTransmitter,
    );
    expect(CCTP_MAINNET_CONFIG.solana.tokenMessengerMinter).toBe(
      CCTP_TESTNET_CONFIG.solana.tokenMessengerMinter,
    );
    expect(CCTP_MAINNET_CONFIG.solana.usdcMint).not.toBe(CCTP_TESTNET_CONFIG.solana.usdcMint);
  });

  it("shares no Starknet address with the testnet config", () => {
    // Every Starknet CCTP contract and USDC itself is network-specific; a shared felt
    // would mean a testnet address leaked into the mainnet config.
    const testnet = new Set(
      [
        CCTP_TESTNET_CONFIG.starknet.messageTransmitter,
        CCTP_TESTNET_CONFIG.starknet.tokenMessenger,
        CCTP_TESTNET_CONFIG.starknet.usdc,
      ].map((a) => BigInt(a)),
    );
    for (const address of [
      CCTP_MAINNET_CONFIG.starknet.messageTransmitter,
      CCTP_MAINNET_CONFIG.starknet.tokenMessenger,
      CCTP_MAINNET_CONFIG.starknet.usdc,
    ]) {
      expect(testnet.has(BigInt(address))).toBe(false);
    }
  });

  it("matches the Starknet addresses a production consumer already bridges with", () => {
    // Independent cross-check of Circle's docs: these are the literals a production
    // consumer bridges with, written here lowercase to prove the comparison is on the felt,
    // not the casing.
    expect(BigInt(CCTP_MAINNET_CONFIG.starknet.messageTransmitter)).toBe(
      BigInt("0x02ebb5777b6dd8b26ea11d68fdf1d2c85cd2099335328be845a28c77a8aef183"),
    );
    expect(BigInt(CCTP_MAINNET_CONFIG.starknet.tokenMessenger)).toBe(
      BigInt("0x07d421b9ca8aa32df259965cda8acb93f7599f69209a41872ae84638b2a20f2a"),
    );
    expect(BigInt(CCTP_MAINNET_CONFIG.starknet.usdc)).toBe(
      BigInt("0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb"),
    );
  });
});

describe("configs and address constants", () => {
  it("give each config its own starknet object, so overriding one leaves ADDRESSES intact", () => {
    // A dapp may override a field on a config it was handed; that must not rewrite the
    // address literals every other consumer of the /addresses subpath reads.
    const testnetUsdc = CCTP_TESTNET_ADDRESSES.starknet.usdc;
    const mainnetUsdc = CCTP_MAINNET_ADDRESSES.starknet.usdc;
    try {
      CCTP_TESTNET_CONFIG.starknet.usdc = "0xdead";
      CCTP_MAINNET_CONFIG.starknet.usdc = "0xdead";
      expect(CCTP_TESTNET_ADDRESSES.starknet.usdc).toBe(testnetUsdc);
      expect(CCTP_MAINNET_ADDRESSES.starknet.usdc).toBe(mainnetUsdc);
    } finally {
      // Restore whichever object the writes landed on, so test order is unaffected.
      CCTP_TESTNET_CONFIG.starknet.usdc = testnetUsdc;
      CCTP_MAINNET_CONFIG.starknet.usdc = mainnetUsdc;
    }
  });
});
