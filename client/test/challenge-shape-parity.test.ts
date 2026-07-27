// client/test/challenge-shape-parity.test.ts
//
// Mirror of the SERVICE's 402 PAYMENT-REQUIRED challenge-shape pin. The service side
// keeps a matching test asserting exactly what its x402 verifier emits — that is the
// single source of truth for the envelope; this file is the client half. Here we
// pin the fields the CLIENT actually reads off the envelope + each `accepts` entry, and
// PROVE it by driving a service-shaped fixture through the real client consumers
// (`challengePriceUsd` + `buildPaymentHeader`). If the service ever drops/renames a field
// the client signs over, one of these two mirrored tests breaks — the cross-repo gate a
// single typecheck can't provide (client and server are separate repos).
//
// CROSS-REPO CONTRACT: keep REQUIRED_ACCEPT_KEYS identical to the worker mirror. A change
// to the challenge envelope or an accepts entry must land in BOTH repos in lockstep.
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { buildPaymentHeader, challengePriceUsd } from "../src/payment";

const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
// Base Sepolia — matches the worker test env's X402_NETWORK; its canonical USDC asset
// (assertNetworkParity checks the client-configured network + canonical token).
const NETWORK = "eip155:84532";
const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAYTO = "0x000000000000000000000000000000000000dEaD";

// The accepts-entry fields the client reads. MUST match the worker mirror's list.
// `extra.{name,version}` is emitted by the worker; the client independently sources the
// EIP-712 domain name/version from getDefaultAsset(network) (pinned by x402-domain-parity),
// so it is present-in-shape here for lockstep even though buildPaymentHeader doesn't read it.
const REQUIRED_ACCEPT_KEYS = [
  "scheme",
  "network",
  "asset",
  "amount",
  "payTo",
  "maxTimeoutSeconds",
  "extra",
] as const;

/** A single worker-shaped v2 accepts entry (mirrors X402Verifier.requirements()). */
function accept(amount: string) {
  return {
    scheme: "exact",
    network: NETWORK,
    asset: USDC_SEPOLIA,
    amount,
    payTo: PAYTO,
    maxTimeoutSeconds: 600,
    extra: { name: "USDC", version: "2" },
  };
}

/** Worker-shaped PAYMENT-REQUIRED envelope, base64-encoded like challenge(). */
function challengeHeader(amounts: string[]): string {
  return btoa(
    JSON.stringify({
      x402Version: 2,
      resource: "/v1/kv/session",
      accepts: amounts.map(accept),
    }),
  );
}

describe("402 PAYMENT-REQUIRED challenge shape parity (client mirror)", () => {
  it("the fixture carries every field the client contract pins", () => {
    const a = accept("5000");
    for (const k of REQUIRED_ACCEPT_KEYS) {
      expect(a, `accept must carry '${k}'`).toHaveProperty(k);
    }
  });

  it("challengePriceUsd reads amount + validates network/asset off the challenge", () => {
    const header = challengeHeader(["5000"]);
    expect(challengePriceUsd(header, undefined, NETWORK)).toBeCloseTo(0.005, 9);
    // A network/asset the client isn't configured for is rejected before pricing.
    expect(() => challengePriceUsd(header, undefined, "eip155:8453")).toThrow(/network/);
  });

  it("buildPaymentHeader signs an authorization matching the challenge's amount + payTo", async () => {
    const account = privateKeyToAccount(PK);
    const header = challengeHeader(["5000"]);
    const paySig = await buildPaymentHeader(account, header, { expectedNetwork: NETWORK });
    const decoded = JSON.parse(atob(paySig));
    // The chosen accepts entry is copied verbatim into PaymentPayload.accepted...
    expect(decoded.accepted.scheme).toBe("exact");
    expect(decoded.accepted.network).toBe(NETWORK);
    // ...and the signed EIP-3009 authorization reflects amount -> value, payTo -> to.
    expect(decoded.payload.authorization.value).toBe("5000");
    expect(getAddress(decoded.payload.authorization.to)).toBe(getAddress(PAYTO));
    expect(getAddress(decoded.payload.authorization.from)).toBe(getAddress(account.address));
  });
});
