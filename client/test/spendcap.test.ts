// client/test/spendcap.test.ts

import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentKV } from "../src/index";
import { AgentKVError, SpendCapError } from "../src/types";

const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const EP = "https://x" as const;
const ENC_KEY = `0x${"22".repeat(32)}` as `0x${string}`;

/**
 * Wrap a real deterministic viem account so a test can assert a payment authorization was never
 * PRODUCED — not merely never SENT. Every other assertion in this file observes what left the
 * process (no fetch at all, or no PAYMENT-SIGNATURE header on a sent request), so a refactor that
 * signed the EIP-3009 authorization and only afterwards threw would keep them all green while
 * breaking the invariant these tests exist for: no signature is produced before the cap check
 * passes. A signed authorization is a bearer instrument — producing one and discarding it is
 * still a leak, since it is spendable by anyone who scrapes it out of a log or a crash dump.
 *
 * Count by primaryType (the technique in paths.test.ts): only EIP-3009
 * `TransferWithAuthorization` moves USDC. Identity (`Request`) and encryption-key (`Derive`)
 * payloads are signed on free and credit-served ops too, so a bare signTypedData call count
 * would fire on ops that never spent a cent.
 */
function payingSigner() {
  const inner = privateKeyToAccount(PK);
  const primaryTypes: string[] = [];
  const signer = {
    address: inner.address,
    signTypedData: (args: any) => {
      primaryTypes.push(args.primaryType as string);
      return inner.signTypedData(args);
    },
    signMessage: (args: { message: string }) => inner.signMessage(args),
  };
  return {
    signer,
    /** EIP-3009 authorizations produced — the only signature that can move money. */
    payments: () => primaryTypes.filter((t) => t === "TransferWithAuthorization").length,
    /** Every EIP-712 payload signed, of any type. Used to show the spy is not inert. */
    allSigned: () => primaryTypes.length,
  };
}

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
  it("deposit over maxSpendUsd throws SpendCapError before any fetch AND before signing", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { signer, payments } = payingSigner();
    const kv = new AgentKV({ signer, endpoint: "https://x", maxSpendUsd: 5 });
    await expect(kv.deposit(10)).rejects.toBeInstanceOf(SpendCapError);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(payments()).toBe(0); // never produced, not merely never sent
  });

  it("deposit with a fractional (sub-atomic) amount throws before any fetch AND before signing", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { signer, payments } = payingSigner();
    const kv = new AgentKV({ signer, endpoint: "https://x" });
    await expect(kv.deposit(1.0000001)).rejects.toThrow(/whole number of atomic USDC units/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(payments()).toBe(0);
  });

  it("deposit below $1 throws before any fetch AND before signing", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { signer, payments } = payingSigner();
    const kv = new AgentKV({ signer, endpoint: "https://x" });
    await expect(kv.deposit(0.5)).rejects.toThrow(/>= \$1/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(payments()).toBe(0);
  });

  it("deposit within cap proceeds and signs exactly one authorization (mocked 402 then success)", async () => {
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
    const { signer, payments } = payingSigner();
    const kv = new AgentKV({ signer, endpoint: "https://x", maxSpendUsd: 10 });
    const r = await kv.deposit(5);
    expect(r.balance).toBe(5000);
    // Positive control for every `payments() === 0` above: a PERMITTED deposit really does
    // produce exactly one EIP-3009 authorization through this same spy. Without this, a spy
    // wired to a signer the client never calls would make all those zeroes pass vacuously.
    expect(payments()).toBe(1);
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

    const { signer, payments } = payingSigner();
    const kv = new AgentKV({ signer, endpoint: "https://x", maxSessionSpendUsd: 12 });

    // First $5 deposit: succeeds, session spend = 5
    const r1 = await kv.deposit(5);
    expect(r1.balance).toBe(5000);

    // Second $5 deposit: succeeds, session spend = 10
    // reset fetch counter so 402 fires again for 2nd deposit
    fetchCount = 0;
    const r2 = await kv.deposit(5);
    expect(r2.balance).toBe(5000);
    expect(payments()).toBe(2); // both permitted deposits signed — the spy is live

    // Third $5 deposit: 10 + 5 = 15 > 12 → throws BEFORE any fetch
    const fetchCountBefore = fetchCount;
    const paymentsBefore = payments();
    await expect(kv.deposit(5)).rejects.toBeInstanceOf(SpendCapError);
    expect(fetchCount).toBe(fetchCountBefore); // no fetch calls on the rejected attempt
    expect(payments()).toBe(paymentsBefore); // …and no authorization signed on it either
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

    const { signer, payments } = payingSigner();
    const kv = new AgentKV({ endpoint: EP, signer, maxSessionSpendUsd: 12 });
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
    // `signed` counts SENT authorizations; this counts PRODUCED ones. Equal means the six
    // refused ops stopped at the reservation without minting a spendable authorization —
    // a reorder that signed first would show 8 here while `signed` stayed 2.
    expect(payments()).toBe(signed);
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

    const { signer, payments } = payingSigner();
    const kv = new AgentKV({ endpoint: EP, signer, maxSessionSpendUsd: 12 });

    // First $5 deposit: succeeds, session spend = 5
    const r1 = await kv.deposit(5);
    expect(r1.balance).toBe(5000);

    // Second $5 deposit: succeeds, session spend = 10
    fetchCount = 0;
    const r2 = await kv.deposit(5);
    expect(r2.balance).toBe(5000);
    expect(payments()).toBe(2); // both permitted deposits signed — the spy is live

    // Third $5 deposit: 10 + 5 = 15 > 12 → throws BEFORE any fetch
    const fetchCountBefore = fetchCount;
    const paymentsBefore = payments();
    await expect(kv.deposit(5)).rejects.toBeInstanceOf(SpendCapError);
    expect(fetchCount).toBe(fetchCountBefore); // no fetch calls on the rejected attempt
    expect(payments()).toBe(paymentsBefore); // …and no authorization signed on it either
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
    const { signer, payments } = payingSigner();
    const kv = new AgentKV({ signer, endpoint: EP, maxSpendUsd: 5 });
    const r = await kv.deposit(5);
    expect(r.balance).toBe(5000);
    expect(payments()).toBe(1); // at-cap is ALLOWED to sign; an off-by-one that refused would show 0
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

    const { signer, payments } = payingSigner();
    const kv = new AgentKV({ signer, endpoint: EP, maxSessionSpendUsd: 10 });

    // First $5 deposit: succeeds, session spend = 5
    const r1 = await kv.deposit(5);
    expect(r1.balance).toBe(5000);

    // Second $5 deposit: 5 + 5 = 10 (exactly at cap) → should succeed, not reject
    fetchCount = 0;
    const r2 = await kv.deposit(5);
    expect(r2.balance).toBe(5000);
    expect(payments()).toBe(2); // the at-cap deposit signed — the spy is live

    // Third $5 deposit: 10 + 5 = 15 > 10 → now throws
    const fetchCountBefore = fetchCount;
    const paymentsBefore = payments();
    await expect(kv.deposit(5)).rejects.toBeInstanceOf(SpendCapError);
    expect(fetchCount).toBe(fetchCountBefore);
    expect(payments()).toBe(paymentsBefore); // over-cap signs nothing
  });

  // SUPERSEDED BY THE PER-OP AUTHORIZED CEILING. This used to assert that an uncapped client
  // ACCEPTS a $0.05 quote, because DEFAULT_MAX_OP_USD was the only guard on the op-price path.
  // A `set` is now additionally bounded by its PINNED price (X402_WRITE_USD = $0.005), which is
  // strictly tighter, so $0.05 is refused — and the old positive control asserted exactly the
  // 10x-inflation window the ceiling exists to close. Re-pointed at the new behavior rather than
  // deleted: something must pin that the tighter guard actually wins on this path.
  // DEFAULT_MAX_OP_USD is NOT dead — it still bounds the inline-payer hook via
  // inlineOpCeilingUsd() — it is simply no longer the binding constraint for set/get.
  // Boundary + honest-quote coverage for the pinned ceiling lives in authorized-ceiling.test.ts.
  it("per-op ceiling beats the $0.05 built-in: an uncapped client REFUSES $0.05 for a $0.005 write", async () => {
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

    // Uncapped client (no maxSpendUsd): $0.05 clears DEFAULT_MAX_OP_USD but is 10x the pinned
    // write price, so the authorized-ceiling guard refuses it before any authorization is signed.
    // `{ signer, encryptionKey }` (not `{ signer }`) so the value key is explicit rather than
    // sign-to-derived — the derivation would add an unrelated `Derive` EIP-712 signature.
    const { signer, payments, allSigned } = payingSigner();
    const kv = new AgentKV({ signer, encryptionKey: ENC_KEY, endpoint: EP });
    await expect(kv.set("test-key", "test-value")).rejects.toBeInstanceOf(SpendCapError);
    expect(n).toBe(1); // stopped at the 402 — the paid retry was never sent
    expect(payments()).toBe(0); // no EIP-3009 authorization was ever PRODUCED
    // The identity `Request` payload on the probe still signed, which is why `payments()`
    // filters by primaryType instead of counting every signTypedData call.
    expect(allSigned()).toBeGreaterThan(0);
  });

  // Also refused by the per-op ceiling, not the $0.05 built-in: at a $0.005 pinned write, every
  // quote above the pin is out of bounds long before $0.05 is. Kept as the far-above-pin case
  // alongside the just-above-pin ones in authorized-ceiling.test.ts.
  it("per-op ceiling: uncapped client rejects $0.051 for a $0.005 write BEFORE signing it", async () => {
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

    const { signer, payments, allSigned } = payingSigner();
    const kv = new AgentKV({ signer, encryptionKey: ENC_KEY, endpoint: EP });
    await expect(kv.set("test-key", "test-value")).rejects.toBeInstanceOf(SpendCapError);
    // The headline pin: a hostile 402 quoting above the ceiling must be refused with NO EIP-3009
    // authorization in existence. Throwing is not enough — sign-then-throw would still have
    // handed out a spendable instrument, and every send-side assertion in this file would miss it.
    expect(payments()).toBe(0);
    // Non-vacuity, inside the very test that asserts zero: the identity `Request` for the probe
    // DID go through this spy, so the 0 above is a real observation of the payment path rather
    // than a spy the client never called.
    expect(allSigned()).toBeGreaterThan(0);
  });
});
