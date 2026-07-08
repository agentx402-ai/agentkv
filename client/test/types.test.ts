// client/test/types.test.ts
import { describe, expect, it } from "vitest";
import {
  chainIdFromCaip2,
  DEFAULT_NETWORK,
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_VERSION,
} from "../src/types";

// Mirror of the backend's CAIP-2 parity test. The
// client and the worker each carry their own chainIdFromCaip2; they MUST map a CAIP-2
// network to the SAME chainId (the EIP-712 domain chainId must match on both sides or
// signed requests fail to verify). Both repos test their impl against this SAME canonical
// table — no cross-repo import. IF YOU CHANGE THIS TABLE, change the worker's in lockstep.
describe("chainIdFromCaip2 — canonical CAIP-2 → chainId (cross-repo contract)", () => {
  const EXPECTED: Record<string, number> = {
    "eip155:8453": 8453, // Base mainnet
    "eip155:84532": 84532, // Base Sepolia
    "eip155:1": 1, // Ethereum mainnet
    "eip155:137": 137, // Polygon
  };
  for (const [network, chainId] of Object.entries(EXPECTED)) {
    it(`maps ${network} → ${chainId}`, () => {
      expect(chainIdFromCaip2(network)).toBe(chainId);
    });
  }
  for (const bad of [
    "",
    "8453",
    "eip155",
    "eip155:",
    "eip155:abc",
    "solana:101",
    "eip155:0",
    "eip155:-1",
  ]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      expect(() => chainIdFromCaip2(bad)).toThrow();
    });
  }
});

describe("client/types", () => {
  it("exposes the EIP-712 domain constants used by the server", () => {
    expect(EIP712_DOMAIN_NAME).toBe("AgentKV");
    expect(EIP712_DOMAIN_VERSION).toBe("1");
  });

  it("defaults to Base mainnet as the active network", () => {
    expect(DEFAULT_NETWORK).toBe("eip155:8453");
  });
});
