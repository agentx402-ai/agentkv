// client/test/crypto.test.ts

import { hexToBytes } from "viem";
import { describe, expect, it } from "vitest";
import {
  DIGEST_SCHEME_V1,
  decrypt,
  deriveKeyMaterial,
  encrypt,
  hashKey,
  normalizeEncryptionKey,
} from "../src/crypto";
import { AgentKVError } from "../src/types";

const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

describe("crypto key derivation", () => {
  it("normalizeEncryptionKey accepts 32-byte hex and bytes, rejects wrong length", () => {
    const hex = `0x${"ab".repeat(32)}` as `0x${string}`;
    expect(normalizeEncryptionKey(hex).length).toBe(32);
    expect(normalizeEncryptionKey(new Uint8Array(32)).length).toBe(32);
    expect(() => normalizeEncryptionKey(new Uint8Array(16))).toThrow(/32 bytes/);
  });
});

const KEY = new Uint8Array(32).fill(7); // raw AES-256 key (encrypt/decrypt use it directly)
const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const bytesToB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

describe("versioned envelope", () => {
  it("round-trips and emits the self-describing 'ak' magic header", async () => {
    const packed = await encrypt(KEY, "hello-🔑");
    const bytes = b64ToBytes(packed);
    expect(bytes[0]).toBe(0x61); // 'a'
    expect(bytes[1]).toBe(0x6b); // 'k'
    expect(await decrypt(KEY, packed)).toBe("hello-🔑");
  });

  it("uses a fresh IV per call: same plaintext -> different ciphertext", async () => {
    expect(await encrypt(KEY, "x")).not.toBe(await encrypt(KEY, "x"));
  });

  it("rejects a tampered header — the kdf_id is bound (flipping it fails)", async () => {
    const bytes = b64ToBytes(await encrypt(KEY, "secret"));
    bytes[4] = bytes[4] ^ 0xff; // flip kdf_id
    await expect(decrypt(KEY, bytesToB64(bytes))).rejects.toThrow();
  });

  it("rejects an unsupported envelope version with a clear, upgrade-pointing error", async () => {
    const bytes = b64ToBytes(await encrypt(KEY, "secret"));
    bytes[2] = 0x02; // a version this client does not understand
    await expect(decrypt(KEY, bytesToB64(bytes))).rejects.toThrow(/not a recognized|upgrade/i);
  });

  it("names a future kdf_id in the error (not an opaque OperationError)", async () => {
    const bytes = b64ToBytes(await encrypt(KEY, "secret"));
    bytes[4] = 0x02; // ver=1, suite=1, kdf=2: a valid-looking FUTURE derivation scheme
    await expect(decrypt(KEY, bytesToB64(bytes))).rejects.toThrow(/kdf=2/i);
  });

  it("binds the key digest into the value AAD: a value served for a DIFFERENT key fails the tag", async () => {
    const blob = await encrypt(KEY, "prod-secret", "digest-A");
    expect(await decrypt(KEY, blob, "digest-A")).toBe("prod-secret"); // correct key digest
    // Server substitutes this ciphertext for a different key's request -> the AAD no longer matches.
    await expect(decrypt(KEY, blob, "digest-B")).rejects.toThrow(
      /different key|wrong encryption key/i,
    );
    await expect(decrypt(KEY, blob)).rejects.toThrow(); // no digest at all also fails
  });
});

describe("deriveKeyMaterial — domain separation", () => {
  it("value/keyName/mac are independent 32-byte keys", () => {
    const km = deriveKeyMaterial(hexToBytes(PK));
    for (const k of [km.value, km.keyName, km.mac]) expect(k.length).toBe(32);
    expect(Array.from(km.value)).not.toEqual(Array.from(km.keyName));
    expect(Array.from(km.value)).not.toEqual(Array.from(km.mac));
    expect(Array.from(km.keyName)).not.toEqual(Array.from(km.mac));
  });
});

describe("hashKey — blind index digest", () => {
  const { mac } = deriveKeyMaterial(hexToBytes(PK));
  it("is deterministic, url-safe-base64, and carries the scheme tag", () => {
    const d = hashKey(mac, "secret:stripe");
    expect(hashKey(mac, "secret:stripe")).toBe(d);
    expect(d).toMatch(/^[A-Za-z0-9_-]+$/); // url-safe; no + / =
    const firstByte = atob(d.replace(/-/g, "+").replace(/_/g, "/")).charCodeAt(0);
    expect(firstByte).toBe(DIGEST_SCHEME_V1);
  });
  it("NFC-normalizes: composed and decomposed forms collide to one digest", () => {
    const composed = "café"; // café — é as U+00E9
    const decomposed = "café"; // café — e + combining acute U+0301
    expect(composed).not.toBe(decomposed);
    expect(hashKey(mac, composed)).toBe(hashKey(mac, decomposed));
  });
  it("is case-sensitive and per-wallet", () => {
    expect(hashKey(mac, "Key")).not.toBe(hashKey(mac, "key"));
    const otherMac = deriveKeyMaterial(new Uint8Array(32).fill(1)).mac;
    expect(hashKey(otherMac, "x")).not.toBe(hashKey(mac, "x"));
  });
});

describe("blind-index golden vectors (frozen wire format)", () => {
  const MAC = new Uint8Array(32).fill(7);

  // These digests are the SERVER-VISIBLE addresses of stored values. Changing the
  // normalization, the scheme tag, the HMAC input, or the base64url alphabet orphans
  // already-stored data with no error — reads simply return null. Pin the exact strings.
  it.each([
    ["session", "AaIBTyUir0KpKocv1FyLNoPbmYf-Is06f6twUDuORtY2"],
    ["café", "ASdH9_l00iBrk_YN6AajHNh15V1J5JwyFRfH8etnJgzJ"], // NFC-composed
    ["ключ", "AZwdzfVVwSQcUAIhIsGSBg_Jj22IO2CSqb_ttHlFIUXZ"],
    ["🔐", "AQhTQp5TqYCSVebXaRtkXxsAYXJlw8MOEUvkpqfOqwPc"],
  ])("hashKey(mac, %s) is frozen", (name, digest) => {
    expect(hashKey(MAC, name)).toBe(digest);
  });

  it("NFD input maps onto the NFC digest (the normalization is frozen, not incidental)", () => {
    expect(hashKey(MAC, "café")).toBe(hashKey(MAC, "café"));
  });

  it("pins the scheme tag as a literal, not as a self-referential import", () => {
    expect(DIGEST_SCHEME_V1).toBe(0x01);
  });
});

describe("decrypt error taxonomy", () => {
  it("all decrypt failures are AgentKVError with code decrypt_failed", async () => {
    const good = await encrypt(KEY, "x");
    const wrongKey = new Uint8Array(32).fill(9);
    const cases: Array<[string, Uint8Array]> = [
      ["!!!not base64!!!", KEY], // atob failure — today a cryptic DOMException "Invalid character"
      [bytesToB64(new Uint8Array([1, 2, 3])), KEY], // no magic / truncated envelope
      [good, wrongKey], // auth-tag failure
    ];
    for (const [packed, key] of cases) {
      const err = await decrypt(key, packed).catch((e) => e);
      expect(err).toBeInstanceOf(AgentKVError);
      expect((err as AgentKVError).code).toBe("decrypt_failed");
    }
  });
});
