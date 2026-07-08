// client/test/spendcap.test.ts

import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentKV } from "../src/index";
import { SpendCapError } from "../src/types";

const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

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
            extra: { name: "USDC", version: "2" },
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
            extra: { name: "USDC", version: "2" },
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
});
