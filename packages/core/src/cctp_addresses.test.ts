import { describe, expect, it } from "vitest";
import { CCTP_MAINNET_ADDRESSES, CCTP_TESTNET_ADDRESSES } from "./cctp_addresses";

// Address literal locks (fund-safety gate)
// This is the source of truth for the CCTP address constants (@starkware-libs/anystark-cctp's
// ./addresses subpath re-exports these). USDC minted to a wrong address is
// unrecoverable, so these literals are pinned as frozen values: a drift here
// means the package ships an address nobody verified. Re-verify against
// https://developers.circle.com/cctp before changing one.

describe("CCTP_TESTNET_ADDRESSES (frozen literals)", () => {
  it("uses Circle's per-chain domain ids: Solana 5, Starknet 25", () => {
    expect(CCTP_TESTNET_ADDRESSES.solana.domain).toBe(5);
    expect(CCTP_TESTNET_ADDRESSES.starknet.domain).toBe(25);
  });

  it("pins Circle's Starknet Sepolia contracts", () => {
    expect(CCTP_TESTNET_ADDRESSES.starknet).toMatchObject({
      messageTransmitter: "0x04db7926C64f1f32a840F3Fa95cB551f3801a3600Bae87aF87807A54DCE12Fe8",
      tokenMessenger: "0x04bDdE1E09a4B09a2F95d893D94a967b7717eB85A3f6dEcA8c080Ee01fBc3370",
      usdc: "0x0512feAc6339Ff7889822cb5aA2a86C848e9D392bB0E3E237C008674feeD8343",
    });
  });

  it("pins the Solana devnet CCTP programs and USDC mint", () => {
    expect(CCTP_TESTNET_ADDRESSES.solana).toMatchObject({
      messageTransmitter: "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC",
      tokenMessengerMinter: "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe",
      usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    });
  });
});

describe("CCTP_MAINNET_ADDRESSES (frozen literals)", () => {
  it("uses Circle's per-chain domain ids: Solana 5, Starknet 25", () => {
    expect(CCTP_MAINNET_ADDRESSES.solana.domain).toBe(5);
    expect(CCTP_MAINNET_ADDRESSES.starknet.domain).toBe(25);
  });

  it("pins Circle's Starknet mainnet contracts", () => {
    expect(CCTP_MAINNET_ADDRESSES.starknet).toMatchObject({
      messageTransmitter: "0x02EBB5777B6dD8B26ea11D68Fdf1D2c85cD2099335328Be845a28c77A8AEf183",
      tokenMessenger: "0x07d421B9cA8aA32DF259965cDA8ACb93F7599F69209A41872AE84638B2A20F2a",
      usdc: "0x033068F6539f8e6e6b131e6B2B814e6c34A5224bC66947c47DaB9dFeE93b35fb",
    });
  });

  it("pins Circle's Solana mainnet programs and the mainnet-beta USDC mint", () => {
    expect(CCTP_MAINNET_ADDRESSES.solana).toMatchObject({
      messageTransmitter: "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC",
      tokenMessengerMinter: "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe",
      usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    });
  });

  it("shares the Solana V2 program ids with testnet but NOT the USDC mint", () => {
    expect(CCTP_MAINNET_ADDRESSES.solana.messageTransmitter).toBe(
      CCTP_TESTNET_ADDRESSES.solana.messageTransmitter,
    );
    expect(CCTP_MAINNET_ADDRESSES.solana.tokenMessengerMinter).toBe(
      CCTP_TESTNET_ADDRESSES.solana.tokenMessengerMinter,
    );
    expect(CCTP_MAINNET_ADDRESSES.solana.usdcMint).not.toBe(CCTP_TESTNET_ADDRESSES.solana.usdcMint);
  });

  it("shares no Starknet address with the testnet config", () => {
    const testnet = new Set(
      [
        CCTP_TESTNET_ADDRESSES.starknet.messageTransmitter,
        CCTP_TESTNET_ADDRESSES.starknet.tokenMessenger,
        CCTP_TESTNET_ADDRESSES.starknet.usdc,
      ].map((a) => BigInt(a)),
    );
    for (const address of [
      CCTP_MAINNET_ADDRESSES.starknet.messageTransmitter,
      CCTP_MAINNET_ADDRESSES.starknet.tokenMessenger,
      CCTP_MAINNET_ADDRESSES.starknet.usdc,
    ]) {
      expect(testnet.has(BigInt(address))).toBe(false);
    }
  });
});
