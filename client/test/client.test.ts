// client/test/client.test.ts
import { hexToBytes } from "viem";
import { describe, expect, it } from "vitest";
import { decrypt, deriveKey, encrypt } from "../src/crypto";

const PK_A = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const PK_B = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba" as const;

describe("crypto.deriveKey", () => {
  it("produces a 32-byte key", () => {
    const key = deriveKey(PK_A);
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32);
  });

  it("is deterministic: same private key -> same key", () => {
    const k1 = deriveKey(PK_A);
    const k2 = deriveKey(PK_A);
    expect(Array.from(k1)).toEqual(Array.from(k2));
  });

  it("different private key -> different key", () => {
    const ka = deriveKey(PK_A);
    const kb = deriveKey(PK_B);
    expect(Array.from(ka)).not.toEqual(Array.from(kb));
  });
});

describe("crypto.encrypt/decrypt", () => {
  const key = deriveKey(PK_A);

  it("round-trips: decrypt(encrypt(x)) === x", async () => {
    const plaintext = JSON.stringify({ hello: "world", n: 42 });
    const packed = await encrypt(key, plaintext);
    const out = await decrypt(key, packed);
    expect(out).toBe(plaintext);
  });

  it("round-trips unicode and empty strings", async () => {
    for (const plaintext of ["", "héllo 世界 🔐", "a".repeat(10000)]) {
      const packed = await encrypt(key, plaintext);
      expect(await decrypt(key, packed)).toBe(plaintext);
    }
  });

  it("produces base64 that is not the plaintext", async () => {
    const plaintext = "super-secret-value";
    const packed = await encrypt(key, plaintext);
    expect(packed).not.toContain(plaintext);
    // base64 alphabet only
    expect(packed).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  it("uses a fresh IV each call: same plaintext -> different ciphertext", async () => {
    const a = await encrypt(key, "same");
    const b = await encrypt(key, "same");
    expect(a).not.toBe(b);
    expect(await decrypt(key, a)).toBe("same");
    expect(await decrypt(key, b)).toBe("same");
  });

  it("decrypt fails when the key is wrong", async () => {
    const packed = await encrypt(key, "secret");
    const wrongKey = deriveKey(PK_B);
    await expect(decrypt(wrongKey, packed)).rejects.toBeDefined();
  });
});

import { privateKeyToAccount } from "viem/accounts";
// append to client/test/client.test.ts
import { afterEach, beforeEach, vi } from "vitest";
import {
  deriveKeyMaterial,
  decrypt as rawDecrypt,
  deriveKey as rawDeriveKey,
  hashKey as rawHashKey,
} from "../src/crypto";
import { AgentKV } from "../src/index";

describe("AgentKV construction", () => {
  it("builds the viem account and exposes .signer / .address", () => {
    const kv = new AgentKV({ privateKey: PK_A, endpoint: "https://api.agentx402.ai" });
    const expected = privateKeyToAccount(PK_A);
    expect(kv.address.toLowerCase()).toBe(expected.address.toLowerCase());
    // signer is optional now (undefined in account-key mode); this is wallet mode.
    expect(kv.signer?.address).toBe(expected.address);
  });
});

describe("AgentKV construction — accountKey discrimination (FIX: value, not key presence)", () => {
  const endpoint = "https://api.agentx402.ai";
  const ENC = `0x${"11".repeat(32)}` as const;

  it("privateKey + accountKey:undefined builds a WALLET-mode client, not account mode", () => {
    // A present-but-undefined accountKey (e.g. from a spread config where accountKey is
    // optional) must NOT enter account-key mode. The old `"accountKey" in opts` check was
    // true for a present-but-undefined key and wrongly threw invalid_config.
    const kv = new AgentKV({ endpoint, privateKey: PK_A, accountKey: undefined } as any);
    const expected = privateKeyToAccount(PK_A);
    expect(kv.accountKey).toBeUndefined(); // NOT account mode
    expect(kv.signer?.address).toBe(expected.address); // a real wallet signer is present
    expect(kv.address).toBe(expected.address); // the wallet address, not the zero sentinel
    expect(kv.address).not.toBe("0x0000000000000000000000000000000000000000");
  });

  it("accountKey:undefined with no privateKey/signer still errors (no silent wallet-less client)", () => {
    // Nothing to authenticate with: neither an account bearer nor a wallet/signer.
    expect(
      () => new AgentKV({ endpoint, accountKey: undefined, encryptionKey: ENC } as any),
    ).toThrow();
  });
});

describe("AgentKV set/get/delete (mocked fetch)", () => {
  const endpoint = "https://api.agentx402.ai";
  let kv: AgentKV;
  let calls: { url: string; init: RequestInit }[];

  beforeEach(() => {
    kv = new AgentKV({ privateKey: PK_A, endpoint });
    calls = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockFetch(handler: (url: string, init: RequestInit) => Response) {
    vi.stubGlobal("fetch", async (input: any, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url;
      const i = init ?? {};
      calls.push({ url, init: i });
      return handler(url, i);
    });
  }

  it("set encrypts the value (server never sees plaintext)", async () => {
    const plaintext = { secret: "do-not-leak", n: 7 };
    let capturedBody: any = null;

    mockFetch((url, init) => {
      capturedBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ ok: true, expires_at: "2026-09-22T00:00:00.000Z" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const res = await kv.set("session", plaintext);
    expect(res.ok).toBe(true);
    expect(res.expires_at).toBe("2026-09-22T00:00:00.000Z");

    // Body carries ciphertext, NOT the plaintext.
    expect(typeof capturedBody.value).toBe("string");
    expect(capturedBody.value).not.toContain("do-not-leak");
    expect(JSON.stringify(capturedBody)).not.toContain("do-not-leak");

    // Ciphertext decrypts back to the original plaintext with the NEW (domain-separated) value key.
    const key = deriveKeyMaterial(hexToBytes(PK_A)).value;
    const decrypted = await rawDecrypt(key, capturedBody.value);
    expect(JSON.parse(decrypted)).toEqual(plaintext);

    // Stable Idempotency-Key is present.
    const idem = new Headers(calls[0].init.headers).get("Idempotency-Key");
    expect(idem).toMatch(/^0x[0-9a-fA-F]{64}$|^[0-9a-fA-F-]{8,}$/);
  });

  it("set addresses the server by an opaque digest and ships the encrypted name (key never on the wire)", async () => {
    let url = "";
    let body: any = null;
    mockFetch((u, init) => {
      url = u;
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ ok: true, expires_at: "x" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    await kv.set("secret:stripe-prod", "v");

    const km = deriveKeyMaterial(hexToBytes(PK_A));
    const digest = rawHashKey(km.mac, "secret:stripe-prod");
    expect(url).toBe(`${endpoint}/v1/kv/${digest}`); // path is the opaque per-wallet digest (default apiVersion "1")
    expect(url).not.toContain("stripe"); // cleartext key name NOT in the URL
    expect(typeof body.key_name).toBe("string");
    expect(JSON.stringify(body)).not.toContain("stripe"); // nor anywhere in the body
    expect(await rawDecrypt(km.keyName, body.key_name)).toBe("secret:stripe-prod"); // name round-trips
  });

  it("listKeys decrypts the server's encrypted names (server stores only digests + ciphertext)", async () => {
    const km = deriveKeyMaterial(hexToBytes(PK_A));
    const names = ["secret:openai", "session:plan"];
    const items = await Promise.all(
      names.map(async (name) => ({
        key: rawHashKey(km.mac, name),
        key_name: await encrypt(km.keyName, name),
      })),
    );
    let hitPath = "";
    mockFetch((u, init) => {
      hitPath = u;
      expect(init.method).toBe("GET");
      return new Response(JSON.stringify({ items, cursor: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const res = await kv.listKeys();
    expect(res.keys.sort()).toEqual([...names].sort());
    expect(res.cursor).toBeNull();
    // Default apiVersion "1": the v1 canonical list path is /v1/kv (NOT /v1/list-keys).
    expect(hitPath).toContain("/v1/kv");
  });

  it("set rejects null and undefined before any network call (so get→null means missing)", async () => {
    await expect(kv.set("k", null)).rejects.toThrow(/null or undefined/);
    await expect(kv.set("k", undefined)).rejects.toThrow(/null or undefined/);
    expect(calls).toHaveLength(0); // rejected client-side, never sent to the server
  });

  it("set still stores falsy non-null values (0, false, empty string)", async () => {
    const stored: unknown[] = [];
    mockFetch((_url, init) => {
      stored.push(JSON.parse(init.body as string).value);
      return new Response(JSON.stringify({ ok: true, expires_at: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    for (const v of [0, false, ""]) {
      expect((await kv.set("k", v)).ok).toBe(true);
    }
    expect(stored).toHaveLength(3); // all three proceeded to an encrypted write
  });

  it("set passes ttl_days and strict_ttl", async () => {
    let capturedBody: any = null;
    mockFetch((url, init) => {
      capturedBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ ok: true, expires_at: "x" }), { status: 200 });
    });
    await kv.set("k", "v", { ttl_days: 1, strict_ttl: true });
    expect(capturedBody.ttl_days).toBe(1);
    expect(capturedBody.strict_ttl).toBe(true);
  });

  it("get decrypts the value returned by the server", async () => {
    const original = { hello: "world" };
    // Encrypt under the PRIMARY domain-separated value key (what a current client writes),
    // so this exercises the primary decrypt path — not the legacy-key fallback (covered
    // separately by the "no-magic LEGACY 0.1.0 blob" test below).
    const key = deriveKeyMaterial(hexToBytes(PK_A)).value;
    const { encrypt } = await import("../src/crypto");
    const ciphertext = await encrypt(key, JSON.stringify(original));

    mockFetch((url, init) => {
      expect(init.method).toBe("GET");
      return new Response(
        JSON.stringify({
          value: ciphertext,
          ttl_days: 90,
          strict_ttl: false,
          expires_at: "x",
          ttl_remaining_seconds: 100,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const out = await kv.get("session");
    expect(out).toEqual(original);
  });

  it("get decrypts a no-magic LEGACY 0.1.0 blob via the value->legacy key fallback", async () => {
    // craft a 0.1.0 blob: base64(IV ‖ ct), NO version header, NO AAD, under the LEGACY key
    const legacyKey = rawDeriveKey(PK_A);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ck = await crypto.subtle.importKey(
      "raw",
      legacyKey as BufferSource,
      { name: "AES-GCM" },
      false,
      ["encrypt"],
    );
    const pt = new TextEncoder().encode(JSON.stringify({ migrated: true }));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv } as AesGcmParams, ck, pt as BufferSource),
    );
    const blob = new Uint8Array(iv.length + ct.length);
    blob.set(iv, 0);
    blob.set(ct, iv.length);
    const ciphertext = btoa(String.fromCharCode(...blob));

    mockFetch(
      () =>
        new Response(JSON.stringify({ value: ciphertext, expires_at: "x" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    expect(await kv.get("legacy-key")).toEqual({ migrated: true });
  });

  it("get returns null on 404", async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ error: "not found", code: "not_found" }), { status: 404 }),
    );
    const out = await kv.get("missing");
    expect(out).toBeNull();
  });

  it("apiVersion:'legacy' set→get round-trips against the LEGACY /kv path, never /v1/kv", async () => {
    // Guards against a future refactor silently dropping the legacy branch: every
    // other set/get test above defaults to apiVersion "1"; this is the one place
    // the pre-versioning path gets exercised end-to-end (encrypt → store → fetch →
    // decrypt), not just path-shape assertions (see paths.test.ts).
    const legacyKv = new AgentKV({ privateKey: PK_A, endpoint, apiVersion: "legacy" });
    const store = new Map<string, string>(); // fake server: url -> stored ciphertext
    const hitUrls: string[] = [];

    mockFetch((url, init) => {
      hitUrls.push(url);
      if (init.method === "GET") {
        return new Response(JSON.stringify({ value: store.get(url), expires_at: "x" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      store.set(url, JSON.parse(init.body as string).value);
      return new Response(JSON.stringify({ ok: true, expires_at: "x" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const original = { hello: "legacy-world" };
    await legacyKv.set("session", original);
    const out = await legacyKv.get("session");
    expect(out).toEqual(original); // round-trip works

    expect(hitUrls).toHaveLength(2);
    for (const url of hitUrls) {
      const path = new URL(url).pathname;
      expect(path).toMatch(/^\/kv\//); // LEGACY path
      expect(path).not.toMatch(/^\/v1\//); // NOT the v1 path
    }
  });

  it("delete sends EIP-712 identity headers and returns ok", async () => {
    mockFetch((url, init) => {
      expect(init.method).toBe("DELETE");
      const h = new Headers(init.headers);
      expect(h.get("X-AgentKV-Signature")).toMatch(/^0x[0-9a-fA-F]+$/);
      expect(h.get("X-AgentKV-Nonce")).toMatch(/^0x[0-9a-fA-F]{64}$/);
      expect(Number(h.get("X-AgentKV-Timestamp"))).toBeGreaterThan(0);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const res = await kv.delete("session");
    expect(res.ok).toBe(true);
  });

  it("set retries with PAYMENT-SIGNATURE on a 402 challenge, reusing the Idempotency-Key", async () => {
    const challenge = btoa(
      JSON.stringify({
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453",
            amount: "5000",
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            payTo: "0x0000000000000000000000000000000000000001",
            resource: "/kv/session",
            description: "write",
            mimeType: "application/json",
            maxTimeoutSeconds: 300,
          },
        ],
      }),
    );

    let attempt = 0;
    mockFetch((url, init) => {
      attempt++;
      if (attempt === 1) {
        return new Response(
          JSON.stringify({ error: "payment required", code: "payment_required" }),
          { status: 402, headers: { "PAYMENT-REQUIRED": challenge } },
        );
      }
      return new Response(JSON.stringify({ ok: true, expires_at: "x" }), { status: 200 });
    });

    const res = await kv.set("session", "v");
    expect(res.ok).toBe(true);
    expect(attempt).toBe(2);

    // PAYMENT-SIGNATURE present on the retry.
    const retryHeaders = new Headers(calls[1].init.headers);
    expect(retryHeaders.get("PAYMENT-SIGNATURE")).toBeTruthy();

    // Same Idempotency-Key across both attempts (exactly-once).
    const idem0 = new Headers(calls[0].init.headers).get("Idempotency-Key");
    const idem1 = retryHeaders.get("Idempotency-Key");
    expect(idem0).toBe(idem1);
  });

  it("set tries the credit path first: identity signature, no payment, on a 200", async () => {
    mockFetch((url, init) => {
      const h = new Headers(init.headers);
      // Credit path: the first attempt carries an EIP-712 identity signature and
      // NO payment, so the server can spend pre-paid credits.
      expect(h.get("X-AgentKV-Signature")).toMatch(/^0x[0-9a-fA-F]+$/);
      expect(h.get("X-AgentKV-Nonce")).toMatch(/^0x[0-9a-fA-F]{64}$/);
      expect(Number(h.get("X-AgentKV-Timestamp"))).toBeGreaterThan(0);
      expect(h.get("PAYMENT-SIGNATURE")).toBeNull();
      return new Response(JSON.stringify({ ok: true, expires_at: "x" }), { status: 200 });
    });
    const res = await kv.set("session", "v");
    expect(res.ok).toBe(true);
    expect(calls.length).toBe(1); // credits covered it; no payment retry
  });

  it("get tries the credit path first: identity signature, no payment, on a 200", async () => {
    const key = deriveKeyMaterial(hexToBytes(PK_A)).value; // primary value key, not legacy
    const { encrypt } = await import("../src/crypto");
    const ciphertext = await encrypt(key, JSON.stringify({ ok: 1 }));
    mockFetch((url, init) => {
      const h = new Headers(init.headers);
      expect(init.method).toBe("GET");
      expect(h.get("X-AgentKV-Signature")).toMatch(/^0x[0-9a-fA-F]+$/);
      expect(h.get("PAYMENT-SIGNATURE")).toBeNull();
      return new Response(
        JSON.stringify({
          value: ciphertext,
          ttl_days: 90,
          strict_ttl: false,
          expires_at: "x",
          ttl_remaining_seconds: 1,
        }),
        { status: 200 },
      );
    });
    const out = await kv.get("session");
    expect(out).toEqual({ ok: 1 });
    expect(calls.length).toBe(1);
  });

  it("get falls back to x402 payment when credits are insufficient (402)", async () => {
    const key = deriveKeyMaterial(hexToBytes(PK_A)).value; // primary value key, not legacy
    const { encrypt } = await import("../src/crypto");
    const ciphertext = await encrypt(key, JSON.stringify("paid-value"));
    const challenge = btoa(
      JSON.stringify({
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453",
            amount: "1000",
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            payTo: "0x0000000000000000000000000000000000000001",
            resource: "/kv/session",
            maxTimeoutSeconds: 300,
          },
        ],
      }),
    );
    let attempt = 0;
    mockFetch((url, init) => {
      attempt++;
      const h = new Headers(init.headers);
      if (attempt === 1) {
        // Credit attempt carries identity; server signals insufficient credits.
        expect(h.get("X-AgentKV-Signature")).toBeTruthy();
        return new Response(
          JSON.stringify({ error: "payment required", code: "payment_required" }),
          { status: 402, headers: { "PAYMENT-REQUIRED": challenge } },
        );
      }
      // Paid retry carries PAYMENT-SIGNATURE.
      expect(h.get("PAYMENT-SIGNATURE")).toBeTruthy();
      return new Response(
        JSON.stringify({
          value: ciphertext,
          ttl_days: 90,
          strict_ttl: false,
          expires_at: "x",
          ttl_remaining_seconds: 1,
        }),
        { status: 200 },
      );
    });
    const out = await kv.get("session");
    expect(out).toBe("paid-value");
    expect(attempt).toBe(2);
  });

  it("reuses a supplied idempotencyKey + deterministic payment nonce across separate set() calls (#2)", async () => {
    const challenge = btoa(
      JSON.stringify({
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453",
            amount: "5000",
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            payTo: "0x0000000000000000000000000000000000000001",
            maxTimeoutSeconds: 600,
          },
        ],
      }),
    );
    const idemHeaders: (string | null)[] = [];
    const paymentNonces: string[] = [];
    mockFetch((url, init) => {
      const h = new Headers(init.headers);
      const paySig = h.get("PAYMENT-SIGNATURE");
      if (paySig) {
        const decoded = JSON.parse(atob(paySig));
        paymentNonces.push(decoded.payload.authorization.nonce);
        return new Response(JSON.stringify({ ok: true, expires_at: "x" }), { status: 200 });
      }
      idemHeaders.push(h.get("Idempotency-Key"));
      return new Response(JSON.stringify({ error: "payment required", code: "payment_required" }), {
        status: 402,
        headers: { "PAYMENT-REQUIRED": challenge },
      });
    });

    await kv.set("session", "v1", { idempotencyKey: "stable-key" });
    await kv.set("session", "v2", { idempotencyKey: "stable-key" });

    // Both credit attempts carry the same supplied Idempotency-Key...
    expect(idemHeaders).toEqual(["stable-key", "stable-key"]);
    // ...and each paid retry reuses the same EIP-3009 authorization nonce.
    expect(paymentNonces).toHaveLength(2);
    expect(paymentNonces[0]).toBe(paymentNonces[1]);
  });

  it("balance() signs an identity request and returns the credit balance", async () => {
    mockFetch((url, init) => {
      const h = new Headers(init.headers);
      expect(url).toContain("/credits/balance");
      expect(h.get("X-AgentKV-Signature")).toMatch(/^0x[0-9a-fA-F]+$/);
      return new Response(JSON.stringify({ balance: 42 }), { status: 200 });
    });
    expect(await kv.balance()).toBe(42);
  });

  it("deposit() pays the chosen tier via x402 on the 402 challenge", async () => {
    const challenge = btoa(
      JSON.stringify({
        x402Version: 2,
        accepts: [1000000, 5000000].map((amt) => ({
          scheme: "exact",
          network: "eip155:8453",
          amount: String(amt),
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x0000000000000000000000000000000000000001",
          maxTimeoutSeconds: 600,
          extra: { name: "USDC", version: "2" },
        })),
      }),
    );
    let attempt = 0;
    let paidAmount: string | null = null;
    mockFetch((url, init) => {
      attempt++;
      const h = new Headers(init.headers);
      if (attempt === 1) {
        expect(h.get("PAYMENT-SIGNATURE")).toBeNull();
        return new Response(
          JSON.stringify({ error: "payment required", code: "payment_required" }),
          { status: 402, headers: { "PAYMENT-REQUIRED": challenge } },
        );
      }
      const paySig = h.get("PAYMENT-SIGNATURE") as string;
      expect(paySig).toBeTruthy();
      paidAmount = JSON.parse(atob(paySig)).payload.authorization.value;
      return new Response(JSON.stringify({ credits_added: 5000, balance: 5000 }), { status: 200 });
    });

    const res = await kv.deposit(5);
    expect(res.credits_added).toBe(5000);
    expect(res.balance).toBe(5000);
    expect(attempt).toBe(2);
    expect(paidAmount).toBe("5000000"); // $5 tier selected by amount
  });

  it("get(key, {idempotencyKey}) sends the key + pins a deterministic payment nonce across retries (H1)", async () => {
    const challenge = btoa(
      JSON.stringify({
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453",
            amount: "1000",
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            payTo: "0x0000000000000000000000000000000000000001",
            maxTimeoutSeconds: 600,
            extra: { name: "USDC", version: "2" },
          },
        ],
      }),
    );
    const dkey = deriveKeyMaterial(hexToBytes(PK_A)).value; // primary value key, not legacy
    const { encrypt } = await import("../src/crypto");
    const ciphertext = await encrypt(dkey, JSON.stringify("v"));

    const idemHeaders: (string | null)[] = [];
    const paymentNonces: string[] = [];
    mockFetch((url, init) => {
      const h = new Headers(init.headers);
      const paySig = h.get("PAYMENT-SIGNATURE");
      if (paySig) {
        paymentNonces.push(JSON.parse(atob(paySig)).payload.authorization.nonce);
        return new Response(
          JSON.stringify({
            value: ciphertext,
            ttl_days: 90,
            strict_ttl: false,
            expires_at: "x",
            ttl_remaining_seconds: 1,
          }),
          { status: 200 },
        );
      }
      idemHeaders.push(h.get("Idempotency-Key"));
      return new Response(JSON.stringify({ error: "payment required", code: "payment_required" }), {
        status: 402,
        headers: { "PAYMENT-REQUIRED": challenge },
      });
    });

    await kv.get("session", { idempotencyKey: "read-key" });
    await kv.get("session", { idempotencyKey: "read-key" });

    // Same Idempotency-Key on the identity attempt + same EIP-3009 nonce on the
    // paid retry across two calls -> the server dedupes a retried paid read.
    expect(idemHeaders).toEqual(["read-key", "read-key"]);
    expect(paymentNonces).toHaveLength(2);
    expect(paymentNonces[0]).toBe(paymentNonces[1]);
  });

  it("delete() surfaces a terminal non-ok as an AgentKVError carrying the server code + status", async () => {
    mockFetch(
      () => new Response(JSON.stringify({ error: "nope", code: "forbidden" }), { status: 403 }),
    );
    await expect(kv.delete("k")).rejects.toMatchObject({
      name: "AgentKVError",
      code: "forbidden",
      status: 403,
    });
  });

  it("listKeys() surfaces a terminal non-ok as an AgentKVError carrying the server code + status", async () => {
    mockFetch(
      () => new Response(JSON.stringify({ error: "bad", code: "unauthorized" }), { status: 401 }),
    );
    await expect(kv.listKeys()).rejects.toMatchObject({
      name: "AgentKVError",
      code: "unauthorized",
      status: 401,
    });
  });

  it("listKeys({cursor, limit}) URL-encodes the query and threads the returned cursor (path-only EIP-712 binding)", async () => {
    const km = deriveKeyMaterial(hexToBytes(PK_A));
    const urls: string[] = [];
    let n = 0;
    mockFetch((u) => {
      urls.push(u);
      n++;
      if (n === 1) {
        return new Response(JSON.stringify({ items: [], cursor: "next+/=cur" }), { status: 200 });
      }
      return new Response(JSON.stringify({ items: [], cursor: null }), { status: 200 });
    });

    const page1 = await kv.listKeys({ cursor: "abc+/=", limit: 2 });
    // Default apiVersion "1": the v1 canonical list path is /v1/kv (NOT /v1/list-keys).
    expect(urls[0]).toBe(`${endpoint}/v1/kv?cursor=abc%2B%2F%3D&limit=2`);
    expect(page1.cursor).toBe("next+/=cur");

    await kv.listKeys({ cursor: page1.cursor, limit: 2 });
    expect(urls[1]).toBe(`${endpoint}/v1/kv?cursor=next%2B%2F%3Dcur&limit=2`);
    // Identity is bound to the bare pathname only (query excluded), so the same nonce
    // scheme applies regardless of the query — the signed path never carries the cursor.
    void km;
  });

  it("listKeys() tolerates one undecryptable key_name (partial listing, not total failure)", async () => {
    const km = deriveKeyMaterial(hexToBytes(PK_A));
    const good = await encrypt(km.keyName, "secret:good");
    const items = [
      { key: rawHashKey(km.mac, "secret:good"), key_name: good },
      { key: "digest-bad", key_name: "%%%not-a-valid-envelope%%%" }, // undecryptable
    ];
    mockFetch(() => new Response(JSON.stringify({ items, cursor: null }), { status: 200 }));
    const res = await kv.listKeys();
    expect(res.keys).toEqual(["secret:good"]); // the healthy name survives; the bad row is skipped
  });

  it("rejects a 402 challenge on a DIFFERENT network than the client is configured for", async () => {
    // A Base-mainnet (default) client must not sign a payment for a challenge that names a
    // different chain — the server does not get to redirect money movement to another network.
    const challenge = btoa(
      JSON.stringify({
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: "eip155:84532", // Sepolia, but the client is eip155:8453
            amount: "5000",
            asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            payTo: "0x0000000000000000000000000000000000000001",
            maxTimeoutSeconds: 600,
          },
        ],
      }),
    );
    mockFetch(
      () =>
        new Response(JSON.stringify({ error: "pay", code: "payment_required" }), {
          status: 402,
          headers: { "PAYMENT-REQUIRED": challenge },
        }),
    );
    await expect(kv.set("k", "v")).rejects.toMatchObject({ code: "network_mismatch" });
  });

  it("rejects a server-quoted op price above the built-in ceiling when no maxSpendUsd is set", async () => {
    // Default (cap-less) client: a compromised server quoting $60 for a routine write must be
    // refused, not silently signed.
    const challenge = btoa(
      JSON.stringify({
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453",
            amount: "60000000", // $60
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            payTo: "0x0000000000000000000000000000000000000001",
            maxTimeoutSeconds: 600,
          },
        ],
      }),
    );
    mockFetch(
      () =>
        new Response(JSON.stringify({ error: "pay", code: "payment_required" }), {
          status: 402,
          headers: { "PAYMENT-REQUIRED": challenge },
        }),
    );
    await expect(kv.set("k", "v")).rejects.toMatchObject({ code: "spend_cap_exceeded" });
  });
});
