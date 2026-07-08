// core/test/payment.test.ts
//
// Moved from client/test/payment.test.ts — this is now the primary,
// deep test suite for the extracted buildPaymentHeader/buildIdentityHeaders/
// freshNonce/nonceFromIdempotencyKey plumbing. client/test/payment.test.ts
// keeps a thin back-compat smoke test asserting the re-exported names still
// resolve and work identically through the client package.

import { getDefaultAsset } from "@x402/evm";
import { getAddress, verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  buildIdentityHeaders,
  buildPaymentHeader,
  chainIdFromCaip2,
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_VERSION,
  freshNonce,
  nonceFromIdempotencyKey,
} from "../src/index";

const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const NETWORK = "eip155:84532";

describe("payment.freshNonce", () => {
  it("returns a 32-byte (bytes32) hex and is fresh each call", () => {
    const a = freshNonce();
    const b = freshNonce();
    expect(a).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(b).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe("payment.buildIdentityHeaders", () => {
  const account = privateKeyToAccount(PK);

  it("produces headers whose signature recovers the wallet address", async () => {
    const headers = await buildIdentityHeaders(account, {
      method: "DELETE",
      path: "/kv/session",
      host: "agentkv.example",
      network: NETWORK,
    });

    expect(headers["X-AgentKV-Signature"]).toMatch(/^0x[0-9a-fA-F]+$/);
    expect(headers["X-AgentKV-Nonce"]).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(Number(headers["X-AgentKV-Timestamp"])).toBeGreaterThan(0);

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

  it("uses a fresh nonce and timestamp per call", async () => {
    const h1 = await buildIdentityHeaders(account, {
      method: "GET",
      path: "/credits/balance",
      host: "agentkv.example",
      network: NETWORK,
    });
    const h2 = await buildIdentityHeaders(account, {
      method: "GET",
      path: "/credits/balance",
      host: "agentkv.example",
      network: NETWORK,
    });
    expect(h1["X-AgentKV-Nonce"]).not.toBe(h2["X-AgentKV-Nonce"]);
  });
});

function encodeChallenge(accepts: unknown[]): string {
  const json = JSON.stringify({ x402Version: 2, accepts });
  return btoa(json);
}

describe("payment.buildPaymentHeader", () => {
  const account = privateKeyToAccount(PK);

  it("decodes the PAYMENT-REQUIRED challenge and returns a base64 PAYMENT-SIGNATURE", async () => {
    const challenge = encodeChallenge([
      {
        scheme: "exact",
        network: NETWORK,
        amount: "5000",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0x0000000000000000000000000000000000000001",
        resource: "/kv/session",
        description: "write",
        mimeType: "application/json",
        maxTimeoutSeconds: 300,
      },
    ]);

    const header = await buildPaymentHeader(account, challenge);

    expect(typeof header).toBe("string");
    expect(header.length).toBeGreaterThan(0);
    // base64 alphabet only
    expect(header).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);

    // decodes to a v2 payment payload referencing the exact scheme & payer. Assert on the
    // ACTUAL field the encoder emits (paymentPayload.accepted.scheme) — the old
    // `decoded.scheme ?? decoded.payload?.scheme ?? "exact"` fell through to the "exact"
    // literal and could never fail, so a wrong/absent scheme would have passed silently.
    const decoded = JSON.parse(atob(header));
    expect(decoded.accepted.scheme).toBe("exact");
    expect(decoded.x402Version).toBe(2);
  });

  it("the signed EIP-3009 authorization VERIFIES against the exact domain + message (recovers the payer)", async () => {
    // Cryptographic pin: a regression that signs the wrong domain — wrong
    // chainId, verifyingContract, or asset name/version — still base64-decodes fine and keeps
    // the right value/nonce, so it passes every other test yet the facilitator rejects every
    // paid op. This recovers the signer from the signature, so a domain drift fails it.
    const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
    const challenge = encodeChallenge([
      {
        scheme: "exact",
        network: NETWORK,
        amount: "5000",
        asset: ASSET,
        payTo: "0x0000000000000000000000000000000000000001",
        maxTimeoutSeconds: 300,
      },
    ]);
    const header = await buildPaymentHeader(account, challenge);
    const auth = JSON.parse(atob(header)).payload.authorization;
    const signature = JSON.parse(atob(header)).payload.signature as `0x${string}`;
    const asset = getDefaultAsset(NETWORK);

    const TWA = {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    } as const;
    const message = {
      from: getAddress(auth.from),
      to: getAddress(auth.to),
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce as `0x${string}`,
    };

    // Correct domain -> recovers the payer.
    expect(
      await verifyTypedData({
        address: account.address,
        domain: {
          name: asset.name,
          version: asset.version,
          chainId: chainIdFromCaip2(NETWORK),
          verifyingContract: getAddress(ASSET),
        },
        types: TWA,
        primaryType: "TransferWithAuthorization",
        message,
        signature,
      }),
    ).toBe(true);

    // Wrong chainId -> does NOT verify (proves the signature is domain-bound, not just shaped right).
    expect(
      await verifyTypedData({
        address: account.address,
        domain: {
          name: asset.name,
          version: asset.version,
          chainId: chainIdFromCaip2(NETWORK) + 1,
          verifyingContract: getAddress(ASSET),
        },
        types: TWA,
        primaryType: "TransferWithAuthorization",
        message,
        signature,
      }),
    ).toBe(false);
  });

  it("throws when no acceptable requirement is present", async () => {
    const challenge = encodeChallenge([]);
    await expect(buildPaymentHeader(account, challenge)).rejects.toBeDefined();
  });

  function multiTier() {
    return encodeChallenge(
      [1000000, 5000000, 10000000].map((amt) => ({
        scheme: "exact",
        network: NETWORK,
        amount: String(amt),
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0x0000000000000000000000000000000000000001",
      })),
    );
  }

  it("selects the accepts entry matching the requested amount (#6 deposit tiers)", async () => {
    const header = await buildPaymentHeader(account, multiTier(), { amountAtomic: 5000000 });
    const decoded = JSON.parse(atob(header));
    expect(decoded.payload.authorization.value).toBe("5000000");
  });

  it("throws on an ambiguous multi-tier challenge with no amount", async () => {
    await expect(buildPaymentHeader(account, multiTier())).rejects.toThrow(/ambiguous/);
  });

  it("nonceFromIdempotencyKey is deterministic and pins the EIP-3009 nonce (#2)", async () => {
    const n1 = nonceFromIdempotencyKey("write-1");
    const n2 = nonceFromIdempotencyKey("write-1");
    const n3 = nonceFromIdempotencyKey("write-2");
    expect(n1).toBe(n2);
    expect(n1).not.toBe(n3);

    const challenge = encodeChallenge([
      {
        scheme: "exact",
        network: NETWORK,
        amount: "5000",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0x0000000000000000000000000000000000000001",
      },
    ]);
    const header = await buildPaymentHeader(account, challenge, { nonce: n1 });
    const decoded = JSON.parse(atob(header));
    expect(decoded.payload.authorization.nonce).toBe(n1);
  });

  it("selects a higher deposit tier ($25) (#6 / T-06)", async () => {
    const tiers = encodeChallenge(
      [1000000, 5000000, 10000000, 25000000, 50000000].map((amt) => ({
        scheme: "exact",
        network: NETWORK,
        amount: String(amt),
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0x0000000000000000000000000000000000000001",
        maxTimeoutSeconds: 600,
        extra: { name: "USDC", version: "2" },
      })),
    );
    const header = await buildPaymentHeader(account, tiers, { amountAtomic: 25000000 });
    expect(JSON.parse(atob(header)).payload.authorization.value).toBe("25000000");
  });

  it("signs an arbitrary amount against a single-accept $1 challenge (T-07 arbitrary-amount)", async () => {
    // Single-accept challenge advertising $1 (1_000_000 atomic)
    const singleDollar = encodeChallenge([
      {
        scheme: "exact",
        network: NETWORK,
        amount: "1000000",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0x0000000000000000000000000000000000000001",
        maxTimeoutSeconds: 300,
      },
    ]);
    // Pass amountAtomic: 20_000_000 ($20) — should synthesize the requirement from the template
    const header = await buildPaymentHeader(account, singleDollar, { amountAtomic: 20_000_000 });
    const decoded = JSON.parse(atob(header));
    // The signed authorization.value must reflect the requested $20, not the template's $1
    expect(decoded.payload.authorization.value).toBe("20000000");
  });
});
