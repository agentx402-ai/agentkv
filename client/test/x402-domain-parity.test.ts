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
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { buildPaymentHeader } from "../src/payment";

const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

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
  it("getDefaultAsset(network).{asset,name,version} match the pinned cross-repo values", () => {
    for (const network of Object.keys(EXPECTED) as (keyof typeof EXPECTED)[]) {
      const asset = getDefaultAsset(network);
      const want = EXPECTED[network];
      // @x402/evm >= 2.23.0 renamed the token-address field `address` -> `asset`.
      expect(asset.asset.toLowerCase()).toBe(want.address.toLowerCase());
      expect(asset.name).toBe(want.name);
      expect(asset.version).toBe(want.version);
    }
  });
});

// buildPaymentHeader() (in @agentx402-ai/core) signs the REGISTRY's EIP-712 domain
// (asset.name/asset.version pinned above), never a challenge's server-supplied `extra` — and
// rejects (`domain_mismatch`) a challenge whose `extra` disagrees with it, so a compromised or
// misconfigured server advertising the wrong domain name gets caught before anything is
// signed, not silently "corrected" into a signature the facilitator would reject anyway. The
// parity assertion above pins that the CONSTANTS are right; these pin that the CLIENT actually
// ENFORCES them against a lying challenge — the two are complementary, not redundant.
//
// This block exists in its own right: a batch of *other* test fixtures across this package had
// hardcoded the wrong `extra.name` for Base mainnet ("USDC" instead of the real "USD Coin"),
// which incidentally exercised this rejection path by accident on every one of them. Correcting
// those fixtures removed that accidental coverage and left this money-safety gate — the one
// thing standing between a hostile/misconfigured server and a client blindly signing whatever
// EIP-712 domain it's told to — with nothing pinning it on purpose.
function challengeHeader(network: keyof typeof EXPECTED, extraName: string): string {
  return btoa(
    JSON.stringify({
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network,
          amount: "5000",
          asset: EXPECTED[network].address,
          payTo: "0x0000000000000000000000000000000000000001",
          maxTimeoutSeconds: 300,
          extra: { name: extraName, version: "2" },
        },
      ],
    }),
  );
}

describe("buildPaymentHeader enforces the domain parity pin (rejects a lying challenge)", () => {
  const account = privateKeyToAccount(PK);

  it('Base mainnet challenge advertising "USDC" (the Sepolia name) is REJECTED as domain_mismatch', async () => {
    const lying = challengeHeader("eip155:8453", "USDC");
    await expect(
      buildPaymentHeader(account, lying, { expectedNetwork: "eip155:8453" }),
    ).rejects.toMatchObject({ code: "domain_mismatch" });
  });

  it('Base mainnet challenge advertising the correct "USD Coin" is accepted (the check does not blanket-reject)', async () => {
    const truthful = challengeHeader("eip155:8453", "USD Coin");
    const header = await buildPaymentHeader(account, truthful, {
      expectedNetwork: "eip155:8453",
    });
    const decoded = JSON.parse(atob(header));
    expect(decoded.accepted.scheme).toBe("exact");
    expect(getAddress(decoded.payload.authorization.from)).toBe(getAddress(account.address));
  });

  it('Base Sepolia challenge advertising its OWN correct "USDC" is accepted — the mainnet/testnet asymmetry is real, not a leftover typo', async () => {
    const truthful = challengeHeader("eip155:84532", "USDC");
    const header = await buildPaymentHeader(account, truthful, {
      expectedNetwork: "eip155:84532",
    });
    const decoded = JSON.parse(atob(header));
    expect(decoded.accepted.scheme).toBe("exact");
    expect(getAddress(decoded.payload.authorization.from)).toBe(getAddress(account.address));
  });
});
