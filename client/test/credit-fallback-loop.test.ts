// client/test/credit-fallback-loop.test.ts
//
// spec-17 credit-fallback loop, end-to-end IN ONE PROCESS. The two existing halves
// each mock the OTHER side: client.test.ts drives 402→sign→retry against a server that
// returns 200 WITHOUT checking the signature, and core/test/payment.test.ts verifies a
// signature in isolation with no op loop. Neither proves that the header the client
// actually emits on the credit-fallback path VERIFIES against the challenge the server
// issued. This test closes that gap with a stateful, signature-VERIFYING fake server:
//
//   1. credit attempt (EIP-712 identity signature, no payment) -> 402 insufficient_credits
//      + a real PAYMENT-REQUIRED challenge,
//   2. the client signs an EIP-3009 authorization off that challenge and retries,
//   3. the server VERIFIES the PAYMENT-SIGNATURE (recovers the signer via viem
//      verifyTypedData over the domain it derived from its OWN challenge, and checks
//      amount/payTo/nonce) and only THEN serves 200.
//
// A regression that makes the client sign the wrong domain/amount/recipient — or reuse a
// stale challenge — turns the server's verify false and the op throws, instead of the
// false-green a blind 200 gives.
import { getDefaultAsset } from "@x402/evm";
import { getAddress, verifyTypedData } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentKV } from "../src/index";

const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const ENDPOINT = "https://api.agentx402.ai";
const NETWORK = "eip155:84532";
const CHAIN_ID = 84532;
const PAYTO = "0x000000000000000000000000000000000000dEaD";

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

function challengeHeader(amountAtomic: string): string {
  const asset = getDefaultAsset(NETWORK);
  return btoa(
    JSON.stringify({
      x402Version: 2,
      resource: "/v1/kv/session",
      accepts: [
        {
          scheme: "exact",
          network: NETWORK,
          asset: asset.address,
          amount: amountAtomic,
          payTo: PAYTO,
          maxTimeoutSeconds: 600,
          extra: { name: asset.name, version: asset.version },
        },
      ],
    }),
  );
}

/**
 * Faithfully verify the client's PAYMENT-SIGNATURE the way the facilitator would: recover
 * the signer over the EIP-3009 domain the SERVER derives from the challenge it issued, and
 * assert the signed authorization matches the advertised amount + recipient.
 */
async function verifyPayment(paymentSignatureHeader: string, wantAmount: string): Promise<boolean> {
  const payload = JSON.parse(atob(paymentSignatureHeader));
  const auth = payload.payload.authorization as {
    from: `0x${string}`;
    to: string;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: `0x${string}`;
  };
  const asset = getDefaultAsset(NETWORK);
  if (auth.value !== wantAmount) return false;
  if (getAddress(auth.to) !== getAddress(PAYTO)) return false;
  return verifyTypedData({
    address: getAddress(auth.from),
    domain: {
      name: asset.name,
      version: asset.version,
      chainId: CHAIN_ID,
      verifyingContract: getAddress(asset.address),
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: getAddress(auth.from),
      to: getAddress(auth.to),
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce,
    },
    signature: payload.payload.signature,
  });
}

describe("spec-17 credit-fallback loop (402 -> sign -> verify -> retry), in-process", () => {
  afterEach(() => vi.restoreAllMocks());

  it("set() falls back to a paid write whose signature verifies against the issued challenge", async () => {
    const WRITE_ATOMIC = "5000"; // $0.005
    const kv = new AgentKV({ privateKey: PK, endpoint: ENDPOINT, network: NETWORK });

    const seen = { creditAttempt: false, paymentVerified: false };
    const idemKeys: (string | null)[] = [];

    vi.stubGlobal("fetch", async (_input: any, init?: RequestInit) => {
      const i = init ?? {};
      const h = new Headers(i.headers);
      idemKeys.push(h.get("Idempotency-Key"));
      const paySig = h.get("PAYMENT-SIGNATURE");

      if (!paySig) {
        // Stage 1 — credit path: an EIP-712 identity signature, NO payment.
        expect(h.get("X-AgentKV-Signature")).toMatch(/^0x[0-9a-fA-F]+$/);
        seen.creditAttempt = true;
        return new Response(
          JSON.stringify({ error: "insufficient credits", code: "insufficient_credits" }),
          { status: 402, headers: { "PAYMENT-REQUIRED": challengeHeader(WRITE_ATOMIC) } },
        );
      }
      // Stage 2 — paid retry: verify the signed authorization for real.
      const ok = await verifyPayment(paySig, WRITE_ATOMIC);
      seen.paymentVerified = ok;
      if (!ok) {
        return new Response(JSON.stringify({ error: "payment invalid", code: "payment_invalid" }), {
          status: 402,
        });
      }
      return new Response(JSON.stringify({ ok: true, expires_at: "2026-10-01T00:00:00.000Z" }), {
        status: 200,
      });
    });

    const res = await kv.set("session", { hello: "world" }, { idempotencyKey: "write-1" });

    expect(res.ok).toBe(true);
    expect(seen.creditAttempt).toBe(true); // the credit attempt happened first
    expect(seen.paymentVerified).toBe(true); // the fallback payment cryptographically verified
    // Exactly-once: the same Idempotency-Key carried across both the credit + paid attempts.
    expect(idemKeys).toEqual(["write-1", "write-1"]);
  });

  it("a tampered challenge amount fails verification (the loop is real, not a blind 200)", async () => {
    const kv = new AgentKV({ privateKey: PK, endpoint: ENDPOINT, network: NETWORK });

    vi.stubGlobal("fetch", async (_input: any, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      const paySig = h.get("PAYMENT-SIGNATURE");
      if (!paySig) {
        return new Response(JSON.stringify({ code: "insufficient_credits" }), {
          status: 402,
          headers: { "PAYMENT-REQUIRED": challengeHeader("5000") },
        });
      }
      // Server expects a DIFFERENT amount than it advertised -> verification must fail,
      // so a broken sign path can't sneak through as a green write.
      const ok = await verifyPayment(paySig, "9999");
      return new Response(JSON.stringify({ code: ok ? "ok" : "payment_invalid" }), {
        status: ok ? 200 : 402,
      });
    });

    await expect(kv.set("session", "v", { idempotencyKey: "write-2" })).rejects.toThrow();
  });
});
