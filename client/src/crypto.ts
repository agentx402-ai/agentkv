// client/src/crypto.ts
import { hkdf } from "@noble/hashes/hkdf";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import { hexToBytes } from "viem";

const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16; // AES-GCM authentication tag

const utf8 = (s: string) => new TextEncoder().encode(s);

// --- Versioned, self-describing envelope --------------------------------------------
// A stored blob is `base64( magic ‖ ver ‖ suite ‖ kdf_id ‖ IV ‖ ct+tag )`. The 5-byte
// header — and, for VALUES, the key's blind-index digest — is bound into the AES-GCM AAD,
// so (a) the scheme ids cannot be stripped or downgraded, and (b) a value encrypted for one
// key cannot be substituted by the server for another key's request: tampering any bound
// byte, or decrypting under a different key's digest, fails the authentication tag.
const MAGIC0 = 0x61; // 'a'
const MAGIC1 = 0x6b; // 'k'
export const ENVELOPE_VER = 0x01;
export const SUITE_AES256GCM = 0x01;
export const KDF_V1 = 0x01; // domain-separated HKDF (salt agentkv/v1/*)
export const DIGEST_SCHEME_V1 = 0x01;
const HEADER = Uint8Array.of(MAGIC0, MAGIC1, ENVELOPE_VER, SUITE_AES256GCM, KDF_V1);
const HEADER_LEN = HEADER.length; // 5

/** Validate/normalize a supplied 32-byte encryption key (used directly as the AES key). */
export function normalizeEncryptionKey(key: Uint8Array | `0x${string}`): Uint8Array {
  const bytes = typeof key === "string" ? hexToBytes(key) : key;
  if (bytes.length !== KEY_LENGTH) {
    throw new Error(`encryption key must be 32 bytes, got ${bytes.length}`);
  }
  return bytes;
}

/**
 * All keys derived from one per-wallet `ikm` with domain-separated HKDF labels — so the
 * value key, the key-name key, and the blind-index MAC key are independent.
 */
export interface KeyMaterial {
  value: Uint8Array; // AES key for values (kdf_id=1)
  keyName: Uint8Array; // AES key for the encrypted key-name
  mac: Uint8Array; // HMAC key for the blind-index digest
}

export function deriveKeyMaterial(ikm: Uint8Array): KeyMaterial {
  return {
    value: hkdf(sha256, ikm, utf8("agentkv/v1/enc"), utf8("value"), KEY_LENGTH),
    keyName: hkdf(sha256, ikm, utf8("agentkv/v1/enc"), utf8("keyname"), KEY_LENGTH),
    mac: hkdf(sha256, ikm, utf8("agentkv/v1/mac"), utf8("lookup"), KEY_LENGTH),
  };
}

/**
 * Blind-index digest for a key NAME: `scheme_tag ‖ HMAC-SHA256(macKey, NFC(name))`,
 * url-safe-base64. Deterministic and per-wallet (macKey is per-wallet), so the server
 * looks up by an opaque token it cannot invert or correlate across wallets. NFC is the
 * frozen normalization (case-sensitive, whitespace-preserving). Used by set/get/delete/list
 * to look a value up under an opaque per-wallet token the server cannot invert.
 */
export function hashKey(macKey: Uint8Array, name: string): string {
  const mac = hmac(sha256, macKey, utf8(name.normalize("NFC")));
  const tagged = new Uint8Array(1 + mac.length);
  tagged[0] = DIGEST_SCHEME_V1;
  tagged.set(mac, 1);
  // MUST stay URL-safe (base64url: [A-Za-z0-9_-], no padding) — kvRoute() embeds this
  // digest directly in the request path without encodeURIComponent.
  return toBase64Url(tagged);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary); // available in Node 18+, browsers, Workers
}

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** AAD = the stored 5-byte header, plus (for values) the key's blind-index digest. */
function aadBytes(aad?: string): Uint8Array<ArrayBuffer> {
  if (!aad) return HEADER;
  const extra = utf8(aad);
  const out = new Uint8Array(HEADER_LEN + extra.length);
  out.set(HEADER, 0);
  out.set(extra, HEADER_LEN);
  return out;
}

async function importAesKey(key: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

async function gcmDecrypt(
  key: Uint8Array,
  iv: Uint8Array<ArrayBuffer>,
  ct: Uint8Array<ArrayBuffer>,
  aad: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const cryptoKey = await importAesKey(key);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: aad },
    cryptoKey,
    ct,
  );
  return new TextDecoder().decode(plaintext);
}

/**
 * Encrypt plaintext with AES-256-GCM, emitting the versioned self-describing envelope
 * `base64( magic ‖ ver ‖ suite ‖ kdf_id ‖ IV ‖ ct+tag )`. The header (and, when `aad` is
 * supplied, the key's digest) is bound into the AAD.
 */
export async function encrypt(key: Uint8Array, plaintext: string, aad?: string): Promise<string> {
  const cryptoKey = await importAesKey(key);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const data = utf8(plaintext);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aadBytes(aad) },
      cryptoKey,
      data,
    ),
  );
  const packed = new Uint8Array(HEADER_LEN + iv.length + ct.length);
  packed.set(HEADER, 0);
  packed.set(iv, HEADER_LEN);
  packed.set(ct, HEADER_LEN + iv.length);
  return toBase64(packed);
}

/**
 * Decrypt a value produced by encrypt(). Requires the versioned envelope (magic + known
 * ver/suite/kdf) and verifies the AAD-bound header (and, when `aad` is supplied, the key's
 * digest — so a value the server serves for the WRONG key fails the tag instead of decrypting).
 */
export async function decrypt(key: Uint8Array, packed: string, aad?: string): Promise<string> {
  const bytes = fromBase64(packed);
  const known =
    bytes.length >= HEADER_LEN + IV_LENGTH + TAG_LENGTH &&
    bytes[0] === MAGIC0 &&
    bytes[1] === MAGIC1 &&
    bytes[2] === ENVELOPE_VER &&
    bytes[3] === SUITE_AES256GCM &&
    bytes[4] === KDF_V1;
  if (!known) {
    throw new Error(
      `decryption failed: not a recognized AgentKV envelope (ver=${bytes[2]}, suite=${bytes[3]}, ` +
        `kdf=${bytes[4]}) — upgrade @agentkv/client, or the encryption key is wrong / the blob is corrupted`,
    );
  }
  try {
    return await gcmDecrypt(
      key,
      bytes.slice(HEADER_LEN, HEADER_LEN + IV_LENGTH),
      bytes.slice(HEADER_LEN + IV_LENGTH),
      aadBytes(aad),
    );
  } catch {
    throw new Error(
      "decryption failed: wrong encryption key, corrupted blob, or a value served for a different key",
    );
  }
}
