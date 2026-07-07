// client/test/x402-domain-parity.test.ts
//
// Pin the x402 USDC asset + EIP-712 domain the client sources from
// getDefaultAsset(network). buildPaymentHeader() (src/payment.ts) signs the EIP-3009
// TransferWithAuthorization over { name: asset.name, version: asset.version, ... }, and
// the facilitator verifies that signature against the BACKEND's requirements — which the
// backend builds from getDefaultAsset(network) too. Client and backend must agree byte-for-byte
// or EVERY paid op fails. typecheck can't catch a semantic drift, so this pins the values.
//
// This is the mirror of the backend's matching x402 domain parity test —
// keep the EXPECTED values identical on both sides. A @x402/evm bump that changes any
// field must be applied to BOTH in lockstep (a one-sided bump breaks every paid op).
// NB: Base mainnet (8453) name is "USD Coin" but Base Sepolia (84532) name is "USDC".
import { getDefaultAsset } from "@x402/evm";
import { describe, expect, it } from "vitest";

const EXPECTED = {
  "eip155:8453": {
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    name: "USD Coin",
    version: "2",
  },
  "eip155:84532": {
    address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    name: "USDC",
    version: "2",
  },
} as const;

describe("x402 USDC asset + EIP-712 domain parity (matches the backend pin)", () => {
  it("getDefaultAsset(network).{address,name,version} match the pinned cross-repo values", () => {
    for (const network of Object.keys(EXPECTED) as (keyof typeof EXPECTED)[]) {
      const asset = getDefaultAsset(network);
      const want = EXPECTED[network];
      expect(asset.address.toLowerCase()).toBe(want.address.toLowerCase());
      expect(asset.name).toBe(want.name);
      expect(asset.version).toBe(want.version);
    }
  });
});
