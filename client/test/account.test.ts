// client/test/account.test.ts
//
// Account-key (bearer) mode: constructor shape, header selection (Bearer, never
// EIP-712 / x402), no payment retry on a 402, encryption with the local key,
// deposit() failing clearly, and the spend cap on a bearer write.

import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateAccountKey, isAccountKeyFormat } from "../src/account";
import {
  decrypt,
  deriveKeyMaterial,
  encrypt,
  hashKey,
  normalizeEncryptionKey,
} from "../src/crypto";
import { AgentKV } from "../src/index";
import { nonceFromIdempotencyKey } from "../src/payment";
import { AgentKVError, SpendCapError } from "../src/types";

const ENDPOINT = "https://api.example.com";
// A fixed, well-formed account key (ak_ + 64 lowercase hex).
const AK = `ak_${"ab".repeat(32)}`;
// Two distinct 32-byte encryption keys.
const ENC_A = `0x${"11".repeat(32)}` as const;
const ENC_B = `0x${"22".repeat(32)}` as const;

describe("account-key primitives", () => {
  it("generateAccountKey() mints ak_ + 64 lowercase hex and passes the format check", () => {
    for (let i = 0; i < 20; i++) {
      const ak = generateAccountKey();
      expect(ak).toMatch(/^ak_[0-9a-f]{64}$/);
      expect(isAccountKeyFormat(ak)).toBe(true);
    }
  });

  it("generateAccountKey() is unique per call (random)", () => {
    const a = generateAccountKey();
    const b = generateAccountKey();
    expect(a).not.toBe(b);
  });

  it("isAccountKeyFormat() rejects bad shapes", () => {
    expect(isAccountKeyFormat(`ak_${"AB".repeat(32)}`)).toBe(false); // uppercase
    expect(isAccountKeyFormat(`ak_${"ab".repeat(31)}`)).toBe(false); // too short
    expect(isAccountKeyFormat(`ak_${"ab".repeat(33)}`)).toBe(false); // too long
    expect(isAccountKeyFormat(`xk_${"ab".repeat(32)}`)).toBe(false); // wrong prefix
    expect(isAccountKeyFormat("ab".repeat(32))).toBe(false); // no prefix
    expect(isAccountKeyFormat(123)).toBe(false);
    expect(isAccountKeyFormat(undefined)).toBe(false);
  });
});

describe("AgentKV account-key constructor", () => {
  it("builds with {accountKey, encryptionKey} and exposes accountKey, no signer", () => {
    const kv = new AgentKV({ accountKey: AK, encryptionKey: ENC_A, endpoint: ENDPOINT });
    expect(kv.accountKey).toBe(AK);
    expect(kv.signer).toBeUndefined();
    // No wallet address in account-key mode.
    expect(kv.address).toBeUndefined();
  });

  it("throws on a malformed accountKey", () => {
    expect(
      () =>
        new AgentKV({
          accountKey: "ak_not-hex",
          encryptionKey: ENC_A,
          endpoint: ENDPOINT,
        }),
    ).toThrow(/ak_<64 lowercase hex>/);
  });

  it("throws when encryptionKey is missing in account mode", () => {
    expect(
      // @ts-expect-error — exercising the runtime guard when the required key is omitted.
      () => new AgentKV({ accountKey: AK, endpoint: ENDPOINT }),
    ).toThrow(/requires an explicit encryptionKey/);
  });

  it("uses the local encryptionKey for key material (no sign-to-derive)", async () => {
    const kv = new AgentKV({ accountKey: AK, encryptionKey: ENC_A, endpoint: ENDPOINT });
    const km = await (kv as any).getKeyMaterial();
    const expected = deriveKeyMaterial(normalizeEncryptionKey(ENC_A));
    expect(Array.from(km.value)).toEqual(Array.from(expected.value));
  });
});

describe("AgentKV account-key header selection (mocked fetch)", () => {
  let calls: { url: string; init: RequestInit }[];

  beforeEach(() => {
    calls = [];
  });
  afterEach(() => vi.restoreAllMocks());

  function mockFetch(handler: (url: string, init: RequestInit) => Response) {
    vi.stubGlobal("fetch", async (input: any, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url;
      const i = init ?? {};
      calls.push({ url, init: i });
      return handler(url, i);
    });
  }

  function assertBearerOnly(h: Headers) {
    expect(h.get("Authorization")).toBe(`Bearer ${AK}`);
    expect(h.get("X-AgentKV-Signature")).toBeNull();
    expect(h.get("X-AgentKV-Nonce")).toBeNull();
    expect(h.get("PAYMENT-SIGNATURE")).toBeNull();
  }

  it("set sends Bearer and never an EIP-712 / x402 header", async () => {
    const kv = new AgentKV({ accountKey: AK, encryptionKey: ENC_A, endpoint: ENDPOINT });
    let body: any = null;
    mockFetch((_u, init) => {
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ ok: true, expires_at: "x" }), { status: 200 });
    });
    const res = await kv.set("session", { secret: "leak-me" });
    expect(res.ok).toBe(true);
    assertBearerOnly(new Headers(calls[0].init.headers));
    // Value is encrypted (ciphertext, not plaintext) even in account mode.
    expect(body.value).not.toContain("leak-me");
  });

  it("get sends Bearer and never an EIP-712 / x402 header", async () => {
    const kv = new AgentKV({ accountKey: AK, encryptionKey: ENC_A, endpoint: ENDPOINT });
    const km = deriveKeyMaterial(normalizeEncryptionKey(ENC_A));
    const ciphertext = await encrypt(
      km.value,
      JSON.stringify({ ok: 1 }),
      hashKey(km.mac, "session"),
    );
    mockFetch((_u, init) => {
      expect(init.method).toBe("GET");
      return new Response(JSON.stringify({ value: ciphertext, expires_at: "x" }), { status: 200 });
    });
    const out = await kv.get("session");
    expect(out).toEqual({ ok: 1 });
    assertBearerOnly(new Headers(calls[0].init.headers));
  });

  it("delete sends Bearer and never an EIP-712 header", async () => {
    const kv = new AgentKV({ accountKey: AK, encryptionKey: ENC_A, endpoint: ENDPOINT });
    mockFetch((_u, init) => {
      expect(init.method).toBe("DELETE");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const res = await kv.delete("session");
    expect(res.ok).toBe(true);
    assertBearerOnly(new Headers(calls[0].init.headers));
  });

  it("listKeys sends Bearer and never an EIP-712 header", async () => {
    const kv = new AgentKV({ accountKey: AK, encryptionKey: ENC_A, endpoint: ENDPOINT });
    const km = deriveKeyMaterial(normalizeEncryptionKey(ENC_A));
    const name = "secret:openai";
    const items = [{ key: "digest1", key_name: await encrypt(km.keyName, name) }];
    mockFetch((u, init) => {
      // Default apiVersion "1": the v1 canonical list path is /v1/kv (NOT /v1/list-keys).
      expect(u).toContain("/v1/kv");
      expect(init.method).toBe("GET");
      return new Response(JSON.stringify({ items, cursor: null }), { status: 200 });
    });
    const res = await kv.listKeys();
    expect(res.keys).toEqual([name]);
    assertBearerOnly(new Headers(calls[0].init.headers));
  });

  it("balance sends Bearer and never an EIP-712 header", async () => {
    const kv = new AgentKV({ accountKey: AK, encryptionKey: ENC_A, endpoint: ENDPOINT });
    mockFetch((u) => {
      expect(u).toContain("/credits/balance");
      return new Response(JSON.stringify({ balance: 7 }), { status: 200 });
    });
    expect(await kv.balance()).toBe(7);
    assertBearerOnly(new Headers(calls[0].init.headers));
  });

  it("a 402 in account mode surfaces as an error and is NOT retried with payment", async () => {
    const kv = new AgentKV({ accountKey: AK, encryptionKey: ENC_A, endpoint: ENDPOINT });
    let attempts = 0;
    mockFetch(() => {
      attempts++;
      // Server (bearer 402) carries NO PAYMENT-REQUIRED challenge.
      return new Response(
        JSON.stringify({ error: "insufficient credits", code: "insufficient_credits" }),
        { status: 402 },
      );
    });
    await expect(kv.set("session", "v")).rejects.toThrow(/insufficient credits|set failed/);
    expect(attempts).toBe(1); // no payment retry
    // The single request carried only the bearer (never PAYMENT-SIGNATURE).
    assertBearerOnly(new Headers(calls[0].init.headers));
  });

  it("get returns null on a 404 in account mode", async () => {
    const kv = new AgentKV({ accountKey: AK, encryptionKey: ENC_A, endpoint: ENDPOINT });
    mockFetch(() => new Response(JSON.stringify({ code: "not_found" }), { status: 404 }));
    expect(await kv.get("missing")).toBeNull();
  });
});

describe("AgentKV account-key encryption round-trip", () => {
  afterEach(() => vi.restoreAllMocks());

  it("a value set in account mode round-trips via get with the same key", async () => {
    const writer = new AgentKV({ accountKey: AK, encryptionKey: ENC_A, endpoint: ENDPOINT });
    let stored: string | null = null;
    vi.stubGlobal("fetch", async (_input: any, init?: RequestInit) => {
      if (init?.method === "GET" || !init?.method) {
        return new Response(JSON.stringify({ value: stored, expires_at: "x" }), { status: 200 });
      }
      stored = JSON.parse(init.body as string).value;
      return new Response(JSON.stringify({ ok: true, expires_at: "x" }), { status: 200 });
    });
    const value = { token: "sk-live-123", n: 42 };
    await writer.set("k", value);
    expect(stored).toBeTruthy();
    // Same key (same client) reads it back.
    expect(await writer.get("k")).toEqual(value);
    // Decrypts directly with the local value key too.
    const km = deriveKeyMaterial(normalizeEncryptionKey(ENC_A));
    expect(
      JSON.parse(await decrypt(km.value, stored as unknown as string, hashKey(km.mac, "k"))),
    ).toEqual(value);
  });

  it("a different encryptionKey fails to decrypt the stored value", async () => {
    const km = deriveKeyMaterial(normalizeEncryptionKey(ENC_A));
    const ciphertext = await encrypt(km.value, JSON.stringify({ secret: 1 }));
    const reader = new AgentKV({ accountKey: AK, encryptionKey: ENC_B, endpoint: ENDPOINT });
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ value: ciphertext, expires_at: "x" }), { status: 200 }),
    );
    await expect(reader.get("k")).rejects.toBeDefined();
  });
});

describe("AgentKV account-key deposit + spend cap", () => {
  afterEach(() => vi.restoreAllMocks());

  it("deposit() throws an instructive error (no signing wallet) before any fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const kv = new AgentKV({ accountKey: AK, encryptionKey: ENC_A, endpoint: ENDPOINT });
    await expect(kv.deposit(5)).rejects.toThrow(/no signing wallet/i);
    await expect(kv.deposit(5)).rejects.toThrow(/account\/deposit/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a WRITE that would exceed maxSpendUsd throws SpendCapError before the request", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    // Per-call cap below the WRITE credit cost ($0.0005) -> any set() trips it.
    const kv = new AgentKV({
      accountKey: AK,
      encryptionKey: ENC_A,
      endpoint: ENDPOINT,
      maxSpendUsd: 0.0001,
    });
    await expect(kv.set("k", "v")).rejects.toBeInstanceOf(SpendCapError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the session cap accumulates across bearer writes", async () => {
    let n = 0;
    vi.stubGlobal("fetch", async () => {
      n++;
      return new Response(JSON.stringify({ ok: true, expires_at: "x" }), { status: 200 });
    });
    // Session cap fits exactly two WRITEs ($0.0005 each) but not a third.
    const kv = new AgentKV({
      accountKey: AK,
      encryptionKey: ENC_A,
      endpoint: ENDPOINT,
      maxSessionSpendUsd: 0.001,
    });
    expect((await kv.set("a", "1")).ok).toBe(true);
    expect((await kv.set("b", "2")).ok).toBe(true);
    const before = n;
    await expect(kv.set("c", "3")).rejects.toBeInstanceOf(SpendCapError);
    expect(n).toBe(before); // third write never hit the network
  });

  it("free ops (delete/listKeys/balance) are NOT gated by the spend cap", async () => {
    vi.stubGlobal("fetch", async (_i: any, init?: RequestInit) => {
      if (init?.method === "DELETE")
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response(JSON.stringify({ items: [], cursor: null, balance: 0 }), { status: 200 });
    });
    // A cap of $0 would block any paid op, but free ops must still proceed.
    const kv = new AgentKV({
      accountKey: AK,
      encryptionKey: ENC_A,
      endpoint: ENDPOINT,
      maxSpendUsd: 0,
      maxSessionSpendUsd: 0,
    });
    expect((await kv.delete("k")).ok).toBe(true);
    expect((await kv.listKeys()).keys).toEqual([]);
    expect(await kv.balance()).toBe(0);
  });
});

// fundAccount(payer, amountUsd): "payer funds, bearer owns". A caller-supplied payer
// wallet pays via x402 to /account/deposit; the account bearer (this client) owns the
// credited namespace. Mirrors the reference fundAccountDeposit flow in
// test-account-integration.mjs (bearer -> 402 challenge -> pay -> {credits_added, balance}).
describe("AgentKV.fundAccount (payer funds, bearer owns)", () => {
  afterEach(() => vi.restoreAllMocks());

  // A fixed payer wallet, DELIBERATELY separate from the account bearer (AK).
  const PAYER_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
  const PAYER_ADDR = privateKeyToAccount(PAYER_PK).address;

  // A v2 PAYMENT-REQUIRED challenge for /account/deposit. buildPaymentHeader overrides
  // the amount from opts.amountAtomic, so the advertised amount here is just a template.
  function depositChallenge(): string {
    return btoa(
      JSON.stringify({
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453",
            amount: "1000000",
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            payTo: "0x0000000000000000000000000000000000000001",
            resource: "/account/deposit",
            maxTimeoutSeconds: 300,
          },
        ],
      }),
    );
  }

  // Mock /account/deposit: the no-payment POST 402s with a challenge; the
  // PAYMENT-SIGNATURE POST returns `paidBody` at `paidStatus`. Captures every request.
  function mockDepositFetch(opts: { paidStatus?: number; paidBody?: unknown } = {}) {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (input: any, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url;
      const i = init ?? {};
      calls.push({ url, init: i });
      const h = new Headers(i.headers);
      if (!h.get("PAYMENT-SIGNATURE")) {
        return new Response(
          JSON.stringify({ error: "payment required", code: "payment_required" }),
          { status: 402, headers: { "PAYMENT-REQUIRED": depositChallenge() } },
        );
      }
      return new Response(
        JSON.stringify(opts.paidBody ?? { credits_added: 10000, balance: 10000 }),
        {
          status: opts.paidStatus ?? 200,
        },
      );
    });
    return calls;
  }

  it("funds via a 402->pay retry: POSTs /account/deposit with bearer + Idempotency-Key + a PAYMENT-SIGNATURE from the PASSED signer", async () => {
    const kv = new AgentKV({ accountKey: AK, encryptionKey: ENC_A, endpoint: ENDPOINT });
    const calls = mockDepositFetch();
    const payer = privateKeyToAccount(PAYER_PK);

    // (c) returns the parsed result.
    const res = await kv.fundAccount(payer, 1);
    expect(res).toEqual({ credits_added: 10000, balance: 10000 });

    // (b) posted to /account/deposit (both the challenge probe and the paid retry).
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.url).toBe(`${ENDPOINT}/v1/account/deposit`); // default apiVersion "1"
      expect(c.init.method).toBe("POST");
    }

    const h0 = new Headers(calls[0].init.headers);
    const h1 = new Headers(calls[1].init.headers);
    // (a) both carry the ACCOUNT bearer; the probe carries NO payment.
    expect(h0.get("Authorization")).toBe(`Bearer ${AK}`);
    expect(h1.get("Authorization")).toBe(`Bearer ${AK}`);
    expect(h0.get("PAYMENT-SIGNATURE")).toBeNull();
    // A stable Idempotency-Key reused across the challenge->pay retry (exactly-once).
    const idem = h0.get("Idempotency-Key");
    expect(idem).toBeTruthy();
    expect(h1.get("Idempotency-Key")).toBe(idem);

    // The paid retry's PAYMENT-SIGNATURE was signed by the PASSED payer (its address is
    // the EIP-3009 `from`), for exactly $1, with the nonce pinned to the idempotency key.
    const paySig = h1.get("PAYMENT-SIGNATURE") as string;
    expect(paySig).toBeTruthy();
    const decoded = JSON.parse(atob(paySig));
    expect(getAddress(decoded.payload.authorization.from)).toBe(getAddress(PAYER_ADDR));
    expect(decoded.payload.authorization.value).toBe("1000000"); // $1 in atomic USDC
    expect(decoded.payload.authorization.nonce).toBe(nonceFromIdempotencyKey(idem as string));
  });

  it("accepts a raw 0x private-key string as the payer (builds the viem account internally)", async () => {
    const kv = new AgentKV({ accountKey: AK, encryptionKey: ENC_A, endpoint: ENDPOINT });
    const calls = mockDepositFetch();

    const res = await kv.fundAccount(PAYER_PK, 3); // hex-string signer, $3
    expect(res).toEqual({ credits_added: 10000, balance: 10000 });

    const paySig = new Headers(calls[1].init.headers).get("PAYMENT-SIGNATURE") as string;
    const decoded = JSON.parse(atob(paySig));
    // Same payer address as the viem-account form -> the hex string was resolved internally.
    expect(getAddress(decoded.payload.authorization.from)).toBe(getAddress(PAYER_ADDR));
    expect(decoded.payload.authorization.value).toBe("3000000"); // $3 in atomic USDC
  });

  it("throws wrong_mode in WALLET mode (no account bearer) before any fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const kv = new AgentKV({ privateKey: PAYER_PK, endpoint: ENDPOINT }); // wallet mode
    await expect(kv.fundAccount(PAYER_PK, 1)).rejects.toMatchObject({ code: "wrong_mode" });
    await expect(kv.fundAccount(PAYER_PK, 1)).rejects.toThrow(/wallet mode use deposit/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects sub-$1 and non-whole-dollar amounts before any fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const kv = new AgentKV({ accountKey: AK, encryptionKey: ENC_A, endpoint: ENDPOINT });
    for (const bad of [0, 0.5, -1, 1.5, Number.NaN]) {
      await expect(kv.fundAccount(PAYER_PK, bad)).rejects.toThrow(/whole number of US dollars/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a malformed payer (undefined / missing address or signTypedData) before any fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const kv = new AgentKV({ accountKey: AK, encryptionKey: ENC_A, endpoint: ENDPOINT });
    const badPayers = [
      undefined,
      null,
      {}, // no address, no signTypedData
      { address: "0x000000000000000000000000000000000000dEaD" }, // no signTypedData
      { signTypedData: async () => "0x" }, // no address
    ];
    for (const bad of badPayers) {
      await expect(kv.fundAccount(bad as any, 1)).rejects.toMatchObject({ code: "invalid_config" });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("maps a server 402 payment_invalid on the paid retry to an AgentKVError (code + status)", async () => {
    const kv = new AgentKV({ accountKey: AK, encryptionKey: ENC_A, endpoint: ENDPOINT });
    mockDepositFetch({
      paidStatus: 402,
      paidBody: { error: "payment invalid", code: "payment_invalid" },
    });
    await expect(kv.fundAccount(PAYER_PK, 1)).rejects.toMatchObject({
      code: "payment_invalid",
      status: 402,
    });
    await expect(kv.fundAccount(PAYER_PK, 1)).rejects.toBeInstanceOf(AgentKVError);
  });
});
