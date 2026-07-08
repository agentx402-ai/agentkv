// client/test/payment.test.ts
//
// The deep payment/auth-header test suite moved to
// core/test/payment.test.ts (the logic now lives in @agentx402-ai/core). This is
// now a thin BACK-COMPAT test: it asserts every name that used to be defined
// here still resolves from `../src/payment` and `../src/types` (existing
// imports elsewhere in this package — and any external consumer — keep
// working unchanged), and does one live round-trip through the re-exported
// functions to prove the shim isn't just a stale name binding.
import { getAddress, verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  buildBearerHeaders,
  buildIdentityHeaders,
  buildPaymentHeader,
  challengePriceUsd,
  decodeBase64Utf8,
  freshNonce,
  nonceFromIdempotencyKey,
  nowSec,
} from "../src/payment";
import { chainIdFromCaip2, EIP712_DOMAIN_NAME, EIP712_DOMAIN_VERSION } from "../src/types";

const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const NETWORK = "eip155:84532";

describe("client/src/payment.ts back-compat re-export (moved to @agentx402-ai/core)", () => {
  it("re-exports every name this module used to define", () => {
    expect(typeof buildBearerHeaders).toBe("function");
    expect(typeof buildIdentityHeaders).toBe("function");
    expect(typeof buildPaymentHeader).toBe("function");
    expect(typeof challengePriceUsd).toBe("function");
    expect(typeof decodeBase64Utf8).toBe("function");
    expect(typeof freshNonce).toBe("function");
    expect(typeof nonceFromIdempotencyKey).toBe("function");
    expect(typeof nowSec).toBe("function");
    expect(typeof chainIdFromCaip2).toBe("function");
    expect(EIP712_DOMAIN_NAME).toBe("AgentKV");
    expect(EIP712_DOMAIN_VERSION).toBe("1");
  });

  it("buildIdentityHeaders (via the shim) produces a signature that verifies (live round-trip)", async () => {
    const account = privateKeyToAccount(PK);
    const headers = await buildIdentityHeaders(account, {
      method: "DELETE",
      path: "/kv/session",
      host: "agentkv.example",
      network: NETWORK,
    });
    const valid = await verifyTypedData({
      address: account.address,
      domain: {
        name: EIP712_DOMAIN_NAME,
        version: EIP712_DOMAIN_VERSION,
        chainId: chainIdFromCaip2(NETWORK),
      },
      types: {
        Request: [
          { name: "method", type: "string" },
          { name: "path", type: "string" },
          { name: "host", type: "string" },
          { name: "nonce", type: "bytes32" },
          { name: "timestamp", type: "uint256" },
        ],
      },
      primaryType: "Request",
      message: {
        method: "DELETE",
        path: "/kv/session",
        host: "agentkv.example",
        nonce: headers["X-AgentKV-Nonce"] as `0x${string}`,
        timestamp: BigInt(headers["X-AgentKV-Timestamp"]),
      },
      signature: headers["X-AgentKV-Signature"] as `0x${string}`,
    });
    expect(valid).toBe(true);
  });

  it("buildBearerHeaders (via the shim) builds the expected Authorization header", () => {
    expect(buildBearerHeaders("ak_abc")).toEqual({ Authorization: "Bearer ak_abc" });
  });

  it("nonceFromIdempotencyKey (via the shim) is deterministic", () => {
    expect(nonceFromIdempotencyKey("write-1")).toBe(nonceFromIdempotencyKey("write-1"));
  });

  it("freshNonce (via the shim) returns a fresh bytes32 hex each call", () => {
    const a = freshNonce();
    const b = freshNonce();
    expect(a).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(a).not.toBe(b);
  });

  function encodeChallenge(accepts: unknown[]): string {
    return btoa(JSON.stringify({ x402Version: 2, accepts }));
  }

  it("buildPaymentHeader (via the shim) signs a v2 PAYMENT-SIGNATURE the getAddress can decode", async () => {
    const account = privateKeyToAccount(PK);
    const challenge = encodeChallenge([
      {
        scheme: "exact",
        network: NETWORK,
        amount: "5000",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0x0000000000000000000000000000000000000001",
        maxTimeoutSeconds: 300,
      },
    ]);
    const header = await buildPaymentHeader(account, challenge);
    const decoded = JSON.parse(atob(header));
    expect(decoded.accepted.scheme).toBe("exact");
    expect(getAddress(decoded.payload.authorization.from)).toBe(getAddress(account.address));
    expect(challengePriceUsd(challenge)).toBeCloseTo(0.005, 6);
  });
});
