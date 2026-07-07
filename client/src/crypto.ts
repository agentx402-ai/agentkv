// client/src/crypto.ts
import { hkdf } from "@noble/hashes/hkdf";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import { hexToBytes } from "viem";

const HKDF_SALT = new TextEncoder().encode("agentkv-v1"); // legacy (pre-skeleton) value key
const HKDF_INFO = new Uint8Array(0);
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16; // AES-GCM authentication tag

const utf8 = (s: string) => new TextEncoder().encode(s);

// --- Versioned, self-describing envelope --------------------------------------------
// A stored blob is `base64( magic ‖ ver ‖ suite ‖ kdf_id ‖ IV ‖ ct+tag )`. The 5-byte
// header is bound into the AES-GCM AAD so its scheme ids cannot be stripped or downgraded
// (tampering any header byte fails the tag). Blobs with NO magic are legacy 0.1.0
// (`base64(IV ‖ ct)`, no AAD) and are decrypted via the trial-decrypt fallback.
const MAGIC0 = 0x61; // 'a'
const MAGIC1 = 0x6b; // 'k'
export const ENVELOPE_VER = 0x01;
export const SUITE_AES256GCM = 0x01;
export const KDF_V1 = 0x01; // domain-separated HKDF (salt agentkv/v1/*)
export const DIGEST_SCHEME_V1 = 0x01;
const HEADER = Uint8Array.of(MAGIC0, MAGIC1, ENVELOPE_VER, SUITE_AES256GCM, KDF_V1);
const HEADER_LEN = HEADER.length; // 5

/** HKDF-SHA256(ikm, salt="agentkv-v1", info="", length=32). Deterministic. (legacy) */
export function deriveKeyFromBytes(ikm: Uint8Array): Uint8Array {
  return hkdf(sha256, ikm, HKDF_SALT, HKDF_INFO, KEY_LENGTH);
}

/** Validate/normalize a supplied 32-byte encryption key (used directly as the AES key). */
export function normalizeEncryptionKey(key: Uint8Array | `0x${string}`): Uint8Array {
  const bytes = typeof key === "string" ? hexToBytes(key) : key;
  if (bytes.length !== KEY_LENGTH) {
    throw new Error(`encryption key must be 32 bytes, got ${bytes.length}`);
  }
  return bytes;
}

/**
 * Derive the 32-byte AES-256-GCM key from the wallet private key (legacy scheme).
 * HKDF-SHA256(ikm = privateKey bytes, salt = "agentkv-v1", info = "", length = 32).
 */
export function deriveKey(privateKey: `0x${string}`): Uint8Array {
  return deriveKeyFromBytes(hexToBytes(privateKey));
}

/**
 * All keys derived from one per-wallet `ikm` with domain-separated HKDF labels — so the
 * value key, the key-name key, and the blind-index MAC key are independent. `legacyValue`
 * is the pre-skeleton value key (or, in explicit mode, the key used directly) kept only to
 * decrypt no-magic 0.1.0 blobs.
 */
export interface KeyMaterial {
  value: Uint8Array; // AES key for values (kdf_id=1)
  keyName: Uint8Array; // AES key for the encrypted key-name (reserved, not yet wired)
  mac: Uint8Array; // HMAC key for the blind-index digest (reserved, not yet wired)
  legacyValue: Uint8Array; // decrypt no-magic legacy blobs only
}

export function deriveKeyMaterial(ikm: Uint8Array, explicit = false): KeyMaterial {
  return {
    value: hkdf(sha256, ikm, utf8("agentkv/v1/enc"), utf8("value"), KEY_LENGTH),
    keyName: hkdf(sha256, ikm, utf8("agentkv/v1/enc"), utf8("keyname"), KEY_LENGTH),
    mac: hkdf(sha256, ikm, utf8("agentkv/v1/mac"), utf8("lookup"), KEY_LENGTH),
    // explicit mode: legacy blobs used the supplied key directly; else the legacy HKDF.
    legacyValue: explicit ? Uint8Array.from(ikm) : deriveKeyFromBytes(ikm),
  };
}

/**
 * Blind-index digest for a key NAME: `scheme_tag ‖ HMAC-SHA256(macKey, NFC(name))`,
 * url-safe-base64. Deterministic and per-wallet (macKey is per-wallet), so the server
 * looks up by an opaque token it cannot invert or correlate across wallets. NFC is the
 * frozen normalization (case-sensitive, whitespace-preserving). NOT yet wired
 * into the request path yet; exported for future use + tests.
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
  aad?: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const cryptoKey = await importAesKey(key);
  const params = aad
    ? { name: "AES-GCM" as const, iv, additionalData: aad }
    : { name: "AES-GCM" as const, iv };
  const plaintext = await crypto.subtle.decrypt(params, cryptoKey, ct);
  return new TextDecoder().decode(plaintext);
}

/**
 * Encrypt plaintext with AES-256-GCM, emitting the versioned self-describing envelope
 * `base64( magic ‖ ver ‖ suite ‖ kdf_id ‖ IV ‖ ct+tag )` with the header bound into AAD.
 */
export async function encrypt(key: Uint8Array, plaintext: string): Promise<string> {
  const cryptoKey = await importAesKey(key);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const data = utf8(plaintext);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: HEADER }, cryptoKey, data),
  );
  const packed = new Uint8Array(HEADER_LEN + iv.length + ct.length);
  packed.set(HEADER, 0);
  packed.set(iv, HEADER_LEN);
  packed.set(ct, HEADER_LEN + iv.length);
  return toBase64(packed);
}

/**
 * Decrypt a value produced by encrypt(). Detects the versioned envelope by its magic and
 * verifies the AAD-bound header; a blob without magic is treated as a legacy 0.1.0
 * `base64(IV ‖ ct)`. A magic-prefixed blob whose tag fails (e.g. a legacy blob whose random
 * IV happened to start with the magic bytes) falls back to the legacy layout.
 */
export async function decrypt(key: Uint8Array, packed: string): Promise<string> {
  const bytes = fromBase64(packed);
  const looksVersioned =
    bytes.length >= HEADER_LEN + IV_LENGTH + TAG_LENGTH &&
    bytes[0] === MAGIC0 &&
    bytes[1] === MAGIC1;
  // Require a KNOWN kdf_id too: kdf_id exists precisely so a future key-derivation
  // scheme bump is detected here. Without this, a valid ver=1/suite=1/kdf=2 blob would
  // pass `known`, fail the v1-key decrypt, fall through to legacy, fail again, and
  // rethrow a raw WebCrypto OperationError instead of the designed "unsupported; upgrade".
  const known =
    looksVersioned &&
    bytes[2] === ENVELOPE_VER &&
    bytes[3] === SUITE_AES256GCM &&
    bytes[4] === KDF_V1;
  if (known) {
    try {
      return await gcmDecrypt(
        key,
        bytes.slice(HEADER_LEN, HEADER_LEN + IV_LENGTH),
        bytes.slice(HEADER_LEN + IV_LENGTH),
        bytes.slice(0, HEADER_LEN), // AAD = the exact stored header → downgrade protection
      );
    } catch {
      // rare: a legacy blob whose random IV began with magic+version bytes — fall through.
    }
  }
  // Legacy 0.1.0 layout: base64(IV ‖ ct), no AAD. This is also the fallback for any
  // versioned-looking blob whose magic-prefix was a coincidence in a legacy IV — so we
  // must ATTEMPT it before declaring an unrecognized version unsupported (otherwise a
  // bare-IV legacy blob starting with the magic bytes would be permanently undecryptable).
  try {
    return await gcmDecrypt(key, bytes.slice(0, IV_LENGTH), bytes.slice(IV_LENGTH));
  } catch (e) {
    // A versioned-looking blob that neither the versioned nor the legacy path could
    // decrypt. This is EITHER a genuine future-scheme envelope (upgrade the client) OR a
    // legacy blob whose random IV coincidentally began with the magic bytes decrypted
    // under the wrong/corrupted key (the ver/suite/kdf shown are then just IV bytes).
    // Hedge the message so it cannot misdirect a user into "upgrading" to fix a key error.
    if (looksVersioned && !known) {
      throw new Error(
        `decryption failed: blob looks like an unsupported AgentKV envelope ` +
          `(ver=${bytes[2]}, suite=${bytes[3]}, kdf=${bytes[4]}) — upgrade @agentkv/client, ` +
          `or the encryption key is wrong / the blob is corrupted`,
      );
    }
    throw e;
  }
}
