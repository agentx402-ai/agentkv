// client/test/spendcap.test.ts

import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentKV } from "../src/index";
import { AgentKVError, SpendCapError } from "../src/types";

const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const EP = "https://x" as const;

// The $5-tier x402 challenge fixture, matching the shape repeated inline throughout this
// file (amount "5000000" = $5.00 atomic USDC). Hoisted so the concurrency test below can
// share it without inventing a new shape.
const CHALLENGE_5 = btoa(
  JSON.stringify({
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        amount: "5000000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0x0000000000000000000000000000000000000001",
        maxTimeoutSeconds: 600,
        extra: { name: "USD Coin", version: "2" },
      },
    ],
  }),
);

/** Install a fetch mock from a (possibly async) handler — mirrors client.test.ts/account.test.ts. */
function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as { url: string }).url;
    return handler(url, init ?? {});
  });
}

afterEach(() => vi.restoreAllMocks());

describe("spend caps", () => {
  it("deposit over maxSpendUsd throws SpendCapError before any fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const kv = new AgentKV({ privateKey: PK, endpoint: "https://x", maxSpendUsd: 5 });
    await expect(kv.deposit(10)).rejects.toBeInstanceOf(SpendCapError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("deposit with a fractional (sub-atomic) amount throws before any fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const kv = new AgentKV({ privateKey: PK, endpoint: "https://x" });
    await expect(kv.deposit(1.0000001)).rejects.toThrow(/whole number of atomic USDC units/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("deposit below $1 throws before any fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const kv = new AgentKV({ privateKey: PK, endpoint: "https://x" });
    await expect(kv.deposit(0.5)).rejects.toThrow(/>= \$1/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("deposit within cap proceeds (mocked 402 then success)", async () => {
    const challenge = btoa(
      JSON.stringify({
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453",
            amount: "5000000",
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            payTo: "0x0000000000000000000000000000000000000001",
            maxTimeoutSeconds: 600,
            extra: { name: "USD Coin", version: "2" },
          },
        ],
      }),
    );
    let n = 0;
    vi.stubGlobal("fetch", async () => {
      n++;
      if (n === 1)
        return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": challenge } });
      return new Response(JSON.stringify({ credits_added: 5000, balance: 5000 }), { status: 200 });
    });
    const kv = new AgentKV({ privateKey: PK, endpoint: "https://x", maxSpendUsd: 10 });
    const r = await kv.deposit(5);
    expect(r.balance).toBe(5000);
  });

  it("session-cap accumulates: third $5 deposit throws SpendCapError before any fetch (cap=$12)", async () => {
    const challenge = btoa(
      JSON.stringify({
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453",
            amount: "5000000",
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            payTo: "0x0000000000000000000000000000000000000001",
            maxTimeoutSeconds: 600,
            extra: { name: "USD Coin", version: "2" },
          },
        ],
      }),
    );
    // Fetch returns 402 then 200 for paid deposits; tracks call count
    let fetchCount = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCount++;
      // Odd calls: 402 challenge; even calls: 200 success
      if (fetchCount % 2 === 1)
        return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": challenge } });
      return new Response(JSON.stringify({ credits_added: 5000, balance: 5000 }), { status: 200 });
    });

    const kv = new AgentKV({ privateKey: PK, endpoint: "https://x", maxSessionSpendUsd: 12 });

    // First $5 deposit: succeeds, session spend = 5
    const r1 = await kv.deposit(5);
    expect(r1.balance).toBe(5000);

    // Second $5 deposit: succeeds, session spend = 10
    // reset fetch counter so 402 fires again for 2nd deposit
    fetchCount = 0;
    const r2 = await kv.deposit(5);
    expect(r2.balance).toBe(5000);

    // Third $5 deposit: 10 + 5 = 15 > 12 → throws BEFORE any fetch
    const fetchCountBefore = fetchCount;
    await expect(kv.deposit(5)).rejects.toBeInstanceOf(SpendCapError);
    expect(fetchCount).toBe(fetchCountBefore); // no fetch calls on the rejected attempt
  });

  it("session cap bounds CONCURRENT spend, not just sequential (reservation, not stale counter)", async () => {
    // Cap $12 with 8 parallel $5 deposits: at most two can fit. Before reservations, all 8
    // checked 0 + 5 <= 12 against the same stale counter and all 8 paid.
    let signed = 0;
    mockFetch(async (_url, init) => {
      const h = new Headers(init.headers);
      if (!h.get("PAYMENT-SIGNATURE")) {
        return new Response(
          JSON.stringify({ error: "payment required", code: "payment_required" }),
          {
            status: 402,
            headers: { "PAYMENT-REQUIRED": CHALLENGE_5 },
          },
        );
      }
      signed++;
      // Yield so every concurrent op is genuinely in flight across an await boundary.
      await new Promise((r) => setTimeout(r, 0));
      return new Response(JSON.stringify({ credits_added: 50000, balance: 50000 }), {
        status: 200,
      });
    });

    const kv = new AgentKV({ endpoint: EP, privateKey: PK, maxSessionSpendUsd: 12 });
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => kv.deposit(5)));
    const paid = results.filter((r) => r.status === "fulfilled").length;
    const capped = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof SpendCapError,
    ).length;

    // Exact, not just an upper bound: toBeLessThanOrEqual(2) alone would also pass if
    // reservations over-counted so badly only ONE (or zero) ops got through — pin the
    // correct answer precisely ($5+$5=$10<=$12; a third $5 would breach).
    expect(signed).toBe(2);
    expect(paid).toBe(signed);
    expect(capped).toBe(8 - paid);
  });

  it("sequential spend is unchanged: three $5 deposits against a $12 cap -> third throws", async () => {
    // Guards against a reservation bug that leaks budget (never released) and starves
    // legitimate sequential ops. Mirrors the existing session-cap test above (same cap,
    // same three-deposit shape), via the shared CHALLENGE_5/mockFetch fixtures.
    let fetchCount = 0;
    mockFetch(async () => {
      fetchCount++;
      // Odd calls: 402 challenge; even calls: 200 success
      if (fetchCount % 2 === 1) {
        return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": CHALLENGE_5 } });
      }
      return new Response(JSON.stringify({ credits_added: 5000, balance: 5000 }), { status: 200 });
    });

    const kv = new AgentKV({ endpoint: EP, privateKey: PK, maxSessionSpendUsd: 12 });

    // First $5 deposit: succeeds, session spend = 5
    const r1 = await kv.deposit(5);
    expect(r1.balance).toBe(5000);

    // Second $5 deposit: succeeds, session spend = 10
    fetchCount = 0;
    const r2 = await kv.deposit(5);
    expect(r2.balance).toBe(5000);

    // Third $5 deposit: 10 + 5 = 15 > 12 → throws BEFORE any fetch
    const fetchCountBefore = fetchCount;
    await expect(kv.deposit(5)).rejects.toBeInstanceOf(SpendCapError);
    expect(fetchCount).toBe(fetchCountBefore); // no fetch calls on the rejected attempt
  });
});

describe("spend-cap option validation (fail closed)", () => {
  const BAD = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, "0,05"];

  it.each(BAD)("rejects maxSpendUsd=%s at construction", (bad) => {
    expect(() => new AgentKV({ endpoint: EP, privateKey: PK, maxSpendUsd: bad as number })).toThrow(
      /maxSpendUsd/,
    );
  });

  it.each(BAD)("rejects maxSessionSpendUsd=%s at construction", (bad) => {
    expect(
      () => new AgentKV({ endpoint: EP, privateKey: PK, maxSessionSpendUsd: bad as number }),
    ).toThrow(/maxSessionSpendUsd/);
  });

  it("a rejected cap carries invalid_config (not a bare Error)", () => {
    const err = (() => {
      try {
        new AgentKV({ endpoint: EP, privateKey: PK, maxSpendUsd: Number.NaN });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(AgentKVError);
    expect((err as AgentKVError).code).toBe("invalid_config");
  });

  it("still accepts an omitted cap, 0, and a finite positive cap", () => {
    expect(new AgentKV({ endpoint: EP, privateKey: PK }).maxSpendUsd).toBeUndefined();
    expect(new AgentKV({ endpoint: EP, privateKey: PK, maxSpendUsd: 0 }).maxSpendUsd).toBe(0);
    expect(new AgentKV({ endpoint: EP, privateKey: PK, maxSpendUsd: 5 }).maxSpendUsd).toBe(5);
  });
});

describe("spend-cap boundary pins (runtime guards)", () => {
  it("per-op cap: spend exactly AT cap is allowed, not rejected", async () => {
    const challenge = btoa(
      JSON.stringify({
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453",
            amount: "5000000", // $5.00 in atomic USDC
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            payTo: "0x0000000000000000000000000000000000000001",
            maxTimeoutSeconds: 600,
            extra: { name: "USD Coin", version: "2" },
          },
        ],
      }),
    );
    let n = 0;
    vi.stubGlobal("fetch", async () => {
      n++;
      if (n === 1)
        return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": challenge } });
      return new Response(JSON.stringify({ credits_added: 5000, balance: 5000 }), { status: 200 });
    });
    // maxSpendUsd: 5 with a $5 deposit should succeed (at-cap, not rejected)
    const kv = new AgentKV({ privateKey: PK, endpoint: EP, maxSpendUsd: 5 });
    const r = await kv.deposit(5);
    expect(r.balance).toBe(5000);
  });

  it("session cap: cumulative spend exactly AT cap across two ops is allowed", async () => {
    const challenge = btoa(
      JSON.stringify({
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453",
            amount: "5000000", // $5.00 in atomic USDC
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            payTo: "0x0000000000000000000000000000000000000001",
            maxTimeoutSeconds: 600,
            extra: { name: "USD Coin", version: "2" },
          },
        ],
      }),
    );
    let fetchCount = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCount++;
      // Odd calls: 402 challenge; even calls: 200 success
      if (fetchCount % 2 === 1)
        return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": challenge } });
      return new Response(JSON.stringify({ credits_added: 5000, balance: 5000 }), { status: 200 });
    });

    const kv = new AgentKV({ privateKey: PK, endpoint: EP, maxSessionSpendUsd: 10 });

    // First $5 deposit: succeeds, session spend = 5
    const r1 = await kv.deposit(5);
    expect(r1.balance).toBe(5000);

    // Second $5 deposit: 5 + 5 = 10 (exactly at cap) → should succeed, not reject
    fetchCount = 0;
    const r2 = await kv.deposit(5);
    expect(r2.balance).toBe(5000);

    // Third $5 deposit: 10 + 5 = 15 > 10 → now throws
    const fetchCountBefore = fetchCount;
    await expect(kv.deposit(5)).rejects.toBeInstanceOf(SpendCapError);
    expect(fetchCount).toBe(fetchCountBefore);
  });

  it("built-in ceiling: uncapped client with server-quoted price EXACTLY at $0.05 is allowed", async () => {
    const challenge = btoa(
      JSON.stringify({
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453",
            amount: "50000", // exactly $0.05 in atomic USDC (50,000 units)
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            payTo: "0x0000000000000000000000000000000000000001",
            maxTimeoutSeconds: 600,
            extra: { name: "USD Coin", version: "2" },
          },
        ],
      }),
    );
    let n = 0;
    vi.stubGlobal("fetch", async () => {
      n++;
      if (n === 1)
        return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": challenge } });
      // Success response for set: just return a basic result
      return new Response(JSON.stringify({ version: 1 }), { status: 200 });
    });

    // Uncapped client (no maxSpendUsd): should accept the $0.05 ceiling
    const kv = new AgentKV({ privateKey: PK, endpoint: EP });
    await kv.set("test-key", "test-value");
    // We're just verifying the op succeeded (no SpendCapError thrown at ceiling check)
    expect(n).toBe(2); // 402 then 200 succeeded
  });

  it("built-in ceiling: uncapped client rejects server-quoted price above $0.05", async () => {
    const challenge = btoa(
      JSON.stringify({
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453",
            amount: "51000", // $0.051 in atomic USDC (just above ceiling)
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            payTo: "0x0000000000000000000000000000000000000001",
            maxTimeoutSeconds: 600,
            extra: { name: "USD Coin", version: "2" },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", async () => {
      return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": challenge } });
    });

    const kv = new AgentKV({ privateKey: PK, endpoint: EP });
    await expect(kv.set("test-key", "test-value")).rejects.toBeInstanceOf(SpendCapError);
  });
});
