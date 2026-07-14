// client/test/expected-payto.test.ts
//
// Client-level `expectedPayTo` recipient pin. `buildPaymentHeader` (in @agentx402-ai/core)
// already supports a per-call `expectedPayTo`; these tests pin the CLIENT surface that
// threads a client-level default into EVERY paying call site (set/get top-off, deposit,
// fundAccount). The per-op amount ceiling bounds HOW MUCH a hostile/mis-set challenge can
// move; the recipient pin bounds WHO it can move it to — the challenge must be REJECTED
// before any EIP-3009 authorization is signed (a signed authorization is a bearer instrument).
import { getAddress } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentKV } from "../src/index";

const PK_A = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const ENDPOINT = "https://api.agentx402.ai";
// The challenge advertises THIS recipient; a matching pin proceeds, a mismatched one rejects.
const PAYTO = "0x0000000000000000000000000000000000000001";
const OTHER = "0x0000000000000000000000000000000000000002";
// Base mainnet (the client default network) canonical USDC — assertNetworkParity must pass
// so the recipient pin is the only gate under test.
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function challengeFor(payTo: string, amount = "5000"): string {
  return btoa(
    JSON.stringify({
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          amount,
          asset: USDC_BASE,
          payTo,
          maxTimeoutSeconds: 300,
          extra: { name: "USD Coin", version: "2" },
        },
      ],
    }),
  );
}

describe("client-level expectedPayTo recipient pin", () => {
  let calls: { url: string; init: RequestInit }[] = [];

  function mockFetch(handler: (url: string, init: RequestInit) => Response) {
    vi.stubGlobal("fetch", async (input: any, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url;
      const i = init ?? {};
      calls.push({ url, init: i });
      return handler(url, i);
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
    calls = [];
  });

  it("rejects a malformed expectedPayTo at construction (fail fast, not on first paying op)", () => {
    expect(
      () => new AgentKV({ privateKey: PK_A, endpoint: ENDPOINT, expectedPayTo: "not-an-address" }),
    ).toThrow(/expectedPayTo must be a valid 0x address/);
  });

  it("normalizes a lowercase expectedPayTo to a checksummed address (no throw)", () => {
    const kv = new AgentKV({
      privateKey: PK_A,
      endpoint: ENDPOINT,
      expectedPayTo: PAYTO.toLowerCase(),
    });
    expect(kv).toBeInstanceOf(AgentKV);
  });

  it("set() proceeds when the challenge payTo matches the client-level pin", async () => {
    const kv = new AgentKV({ privateKey: PK_A, endpoint: ENDPOINT, expectedPayTo: PAYTO });
    let attempt = 0;
    mockFetch((_url, init) => {
      attempt++;
      if (attempt === 1) {
        return new Response(
          JSON.stringify({ error: "payment required", code: "payment_required" }),
          {
            status: 402,
            headers: { "PAYMENT-REQUIRED": challengeFor(PAYTO) },
          },
        );
      }
      // The paid retry must target the pinned recipient.
      const paySig = new Headers(init.headers).get("PAYMENT-SIGNATURE") as string;
      expect(getAddress(JSON.parse(atob(paySig)).payload.authorization.to)).toBe(getAddress(PAYTO));
      return new Response(JSON.stringify({ ok: true, expires_at: "x" }), { status: 200 });
    });

    const res = await kv.set("session", "v");
    expect(res.ok).toBe(true);
    expect(attempt).toBe(2); // 402 then a signed paid retry
  });

  it("set() REJECTS a mismatched-payTo challenge BEFORE signing/retrying", async () => {
    const kv = new AgentKV({ privateKey: PK_A, endpoint: ENDPOINT, expectedPayTo: OTHER });
    let attempt = 0;
    mockFetch((_url, _init) => {
      attempt++;
      // Only ever the initial credit attempt returns a (hostile) 402 — the pin must fire
      // before any PAYMENT-SIGNATURE retry is sent to the network.
      return new Response(JSON.stringify({ error: "payment required", code: "payment_required" }), {
        status: 402,
        headers: { "PAYMENT-REQUIRED": challengeFor(PAYTO) },
      });
    });

    await expect(kv.set("session", "v")).rejects.toThrow(/payTo/);
    expect(attempt).toBe(1); // 402 seen, NO paid retry — nothing was signed/sent
    expect(calls.every((c) => !new Headers(c.init.headers).get("PAYMENT-SIGNATURE"))).toBe(true);
  });

  it("a per-call deposit() expectedPayTo overrides a mismatched client-level default", async () => {
    // Client-level pin is OTHER, but the deposit pins PAYTO explicitly — the per-call value wins.
    const kv = new AgentKV({ privateKey: PK_A, endpoint: ENDPOINT, expectedPayTo: OTHER });
    let attempt = 0;
    mockFetch((_url, init) => {
      attempt++;
      if (attempt === 1) {
        return new Response(
          JSON.stringify({ error: "payment required", code: "payment_required" }),
          {
            status: 402,
            headers: { "PAYMENT-REQUIRED": challengeFor(PAYTO, "5000000") },
          },
        );
      }
      const paySig = new Headers(init.headers).get("PAYMENT-SIGNATURE") as string;
      expect(getAddress(JSON.parse(atob(paySig)).payload.authorization.to)).toBe(getAddress(PAYTO));
      return new Response(JSON.stringify({ credits_added: 5000, balance: 5000 }), { status: 200 });
    });

    const res = await kv.deposit(5, { expectedPayTo: PAYTO });
    expect(res.credits_added).toBe(5000);
    expect(attempt).toBe(2);
  });
});
