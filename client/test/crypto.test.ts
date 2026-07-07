// client/test/crypto.test.ts

import { hexToBytes } from "viem";
import { describe, expect, it } from "vitest";
import {
  DIGEST_SCHEME_V1,
  decrypt,
  deriveKey,
  deriveKeyFromBytes,
  deriveKeyMaterial,
  encrypt,
  hashKey,
  normalizeEncryptionKey,
} from "../src/crypto";

const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

describe("crypto key derivation", () => {
  it("deriveKey equals deriveKeyFromBytes(hexToBytes(pk)) — parity preserved", () => {
    expect(Array.from(deriveKey(PK))).toEqual(Array.from(deriveKeyFromBytes(hexToBytes(PK))));
  });
  it("deriveKeyFromBytes is deterministic and 32 bytes", () => {
    const a = deriveKeyFromBytes(new Uint8Array([1, 2, 3]));
    const b = deriveKeyFromBytes(new Uint8Array([1, 2, 3]));
    expect(a.length).toBe(32);
    expect(Array.from(a)).toEqual(Array.from(b));
  });
  it("normalizeEncryptionKey accepts 32-byte hex and bytes, rejects wrong length", () => {
    const hex = `0x${"ab".repeat(32)}` as `0x${string}`;
    expect(normalizeEncryptionKey(hex).length).toBe(32);
    expect(normalizeEncryptionKey(new Uint8Array(32)).length).toBe(32);
    expect(() => normalizeEncryptionKey(new Uint8Array(16))).toThrow(/32 bytes/);
  });
});

const KEY = deriveKeyFromBytes(new Uint8Array(32).fill(7));
const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const bytesToB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

/** Produce a legacy 0.1.0 blob: base64(IV ‖ ct), NO version header and NO AAD. */
async function makeLegacyBlob(
  key: Uint8Array,
  plaintext: string,
  iv: Uint8Array<ArrayBuffer> = crypto.getRandomValues(new Uint8Array(12)),
): Promise<string> {
  const ck = await crypto.subtle.importKey("raw", key as BufferSource, { name: "AES-GCM" }, false, [
    "encrypt",
  ]);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv } as AesGcmParams,
      ck,
      new TextEncoder().encode(plaintext) as BufferSource,
    ),
  );
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv, 0);
  packed.set(ct, iv.length);
  return bytesToB64(packed);
}

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

  it("rejects a tampered header — the kdf_id is AAD-bound (flipping it fails the tag)", async () => {
    const bytes = b64ToBytes(await encrypt(KEY, "secret"));
    bytes[4] = bytes[4] ^ 0xff; // flip kdf_id: ver/suite stay valid, but the AAD changes
    await expect(decrypt(KEY, bytesToB64(bytes))).rejects.toThrow();
  });

  it("rejects an unsupported envelope version", async () => {
    const bytes = b64ToBytes(await encrypt(KEY, "secret"));
    bytes[2] = 0x02; // a version this client does not understand
    await expect(decrypt(KEY, bytesToB64(bytes))).rejects.toThrow(/unsupported/i);
  });

  it("reports a clear 'unsupported … kdf=N; upgrade' error for a future kdf_id (not an opaque OperationError)", async () => {
    // ver=1, suite=1, kdf=2: a valid-looking FUTURE key-derivation scheme this client cannot
    // handle. Without gating `known` on kdf_id, this fell through to legacy decrypt and rethrew
    // a raw WebCrypto OperationError; now it names the mismatch and points at an upgrade.
    const bytes = b64ToBytes(await encrypt(KEY, "secret"));
    bytes[4] = 0x02;
    await expect(decrypt(KEY, bytesToB64(bytes))).rejects.toThrow(/unsupported.*kdf=2/i);
  });

  it("decrypts a LEGACY (no-magic, no-AAD) 0.1.0 blob via the trial-decrypt fallback", async () => {
    const packed = await makeLegacyBlob(KEY, "legacy-value");
    expect(await decrypt(KEY, packed)).toBe("legacy-value");
  });

  it("does NOT brick a legacy blob whose IV begins with the magic bytes (regression)", async () => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    iv[0] = 0x61; // 'a'
    iv[1] = 0x6b; // 'k'
    iv[2] = 0x42; // NOT the version byte: must fall through to legacy decrypt, never throw "unsupported"
    const packed = await makeLegacyBlob(KEY, "legacy-collide", iv);
    expect(await decrypt(KEY, packed)).toBe("legacy-collide");
  });
});

describe("deriveKeyMaterial — domain separation", () => {
  it("value/keyName/mac are independent 32-byte keys; legacyValue = old deriveKey", () => {
    const km = deriveKeyMaterial(hexToBytes(PK));
    for (const k of [km.value, km.keyName, km.mac, km.legacyValue]) expect(k.length).toBe(32);
    expect(Array.from(km.value)).not.toEqual(Array.from(km.keyName));
    expect(Array.from(km.value)).not.toEqual(Array.from(km.mac));
    expect(Array.from(km.keyName)).not.toEqual(Array.from(km.mac));
    expect(Array.from(km.legacyValue)).toEqual(Array.from(deriveKey(PK)));
  });
  it("explicit mode: legacyValue is the supplied key; value is HKDF'd (not raw)", () => {
    const ikm = new Uint8Array(32).fill(9);
    const km = deriveKeyMaterial(ikm, true);
    expect(Array.from(km.legacyValue)).toEqual(Array.from(ikm));
    expect(Array.from(km.value)).not.toEqual(Array.from(ikm));
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
    const composed = "café"; // café (U+00E9)
    const decomposed = "café"; // café (e + U+0301)
    expect(composed).not.toBe(decomposed);
    expect(hashKey(mac, composed)).toBe(hashKey(mac, decomposed));
  });
  it("is case-sensitive and per-wallet", () => {
    expect(hashKey(mac, "Key")).not.toBe(hashKey(mac, "key"));
    const otherMac = deriveKeyMaterial(new Uint8Array(32).fill(1)).mac;
    expect(hashKey(otherMac, "x")).not.toBe(hashKey(mac, "x"));
  });
});
