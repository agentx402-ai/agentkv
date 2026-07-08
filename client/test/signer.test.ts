// client/test/signer.test.ts

import { hexToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { decrypt, deriveKeyMaterial, encrypt, normalizeEncryptionKey } from "../src/crypto";
import { AgentKV } from "../src/index";

const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const ENDPOINT = "https://api.example.com";

describe("AgentKV constructor shapes", () => {
  it("(1) privateKey: value key = domain-separated scheme", async () => {
    const kv = new AgentKV({ privateKey: PK, endpoint: ENDPOINT });
    const km = await (kv as any).getKeyMaterial();
    expect(Array.from(km.value)).toEqual(Array.from(deriveKeyMaterial(hexToBytes(PK)).value));
    expect(kv.address).toBe(privateKeyToAccount(PK).address);
  });

  it("(2) signer + encryptionKey: value key = HKDF(explicit key)", async () => {
    const signer = privateKeyToAccount(PK);
    const encKey = normalizeEncryptionKey(`0x${"cd".repeat(32)}` as `0x${string}`);
    const kv = new AgentKV({ signer, encryptionKey: encKey, endpoint: ENDPOINT });
    const km = await (kv as any).getKeyMaterial();
    expect(Array.from(km.value)).toEqual(Array.from(deriveKeyMaterial(encKey).value));
    const packed = await encrypt(km.value, "hello");
    expect(await decrypt(km.value, packed)).toBe("hello"); // round-trips under the value key
  });

  it("(3) signer-only derives a deterministic value key from a fixed-message signature", async () => {
    const signer = privateKeyToAccount(PK);
    const a = await (new AgentKV({ signer, endpoint: ENDPOINT }) as any).getKeyMaterial();
    const b = await (new AgentKV({ signer, endpoint: ENDPOINT }) as any).getKeyMaterial();
    expect(a.value.length).toBe(32);
    expect(Array.from(a.value)).toEqual(Array.from(b.value)); // deterministic across instances
  });

  it("(4) signer-only: a value round-trips through encrypt/decrypt with the derived key", async () => {
    const signer = privateKeyToAccount(PK);
    const km = await (new AgentKV({ signer, endpoint: ENDPOINT }) as any).getKeyMaterial();
    const packed = await encrypt(km.value, "signer-value-🔐");
    expect(await decrypt(km.value, packed)).toBe("signer-value-🔐");
  });

  it("defaults to Base mainnet", () => {
    const kv = new AgentKV({ privateKey: PK, endpoint: ENDPOINT });
    expect(kv.network).toBe("eip155:8453");
  });
});

describe("key-derivation golden vectors (data-durability contract)", () => {
  // Hardcoded EXPECTED bytes for the fixed PK. Every other derivation test is relational
  // (function-under-test vs itself, determinism, pairwise inequality) and would stay green
  // through a change to HKDF_SALT, the domain labels, the info strings, or the sign-to-derive
  // handling — silently re-keying every user (and, via the blind-index mac, orphaning all
  // their data). These pin the ACTUAL bytes, so any such change is a caught, deliberate break.
  const PRIVATEKEY_MODE = {
    value: "0xc8f5e5e61331d268f5d2a771bb4be5a3f24f9331c832cf730c650fb71163ac2f",
    keyName: "0x36c49608abc3da2111cf1f65a5fb06eb116700c06d6987501420547877818a96",
    mac: "0x16b5166eacb2e9ea1fee40cc7ff2d504c42c7263570ce4e5bb3507e5beef01af",
  };
  const SIGNER_MODE = {
    value: "0x8f1ba23b8ffe2ceed2837c7fc541a509a509004206c5095b9f848ae9f3d62d0b",
    keyName: "0x44951547e2ddfa770cdbb88e0841d01cdcfc6faabbfa32f91bdc28c050adc209",
    mac: "0xe7985ee40a9dfe93361fd8a89c041f9b7c41accfd900546bd4eb3ac0ce1df4ad",
  };
  const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}`;

  it("privateKey mode derives the pinned value/keyName/mac bytes", async () => {
    const km = await (new AgentKV({ privateKey: PK, endpoint: ENDPOINT }) as any).getKeyMaterial();
    expect(hex(km.value)).toBe(PRIVATEKEY_MODE.value);
    expect(hex(km.keyName)).toBe(PRIVATEKEY_MODE.keyName);
    expect(hex(km.mac)).toBe(PRIVATEKEY_MODE.mac);
  });

  it("signer sign-to-derive mode derives the pinned value/keyName/mac bytes", async () => {
    const signer = privateKeyToAccount(PK);
    const km = await (new AgentKV({ signer, endpoint: ENDPOINT }) as any).getKeyMaterial();
    expect(hex(km.value)).toBe(SIGNER_MODE.value);
    expect(hex(km.keyName)).toBe(SIGNER_MODE.keyName);
    expect(hex(km.mac)).toBe(SIGNER_MODE.mac);
  });

  it("privateKey and sign-to-derive derive DIFFERENT keys for the same wallet (documented divergence)", async () => {
    // The two shapes are NOT interchangeable — pinned here so nobody accidentally "unifies"
    // them into a silent re-key. Callers who need to move between shapes pass an explicit key.
    expect(PRIVATEKEY_MODE.value).not.toBe(SIGNER_MODE.value);
    expect(PRIVATEKEY_MODE.mac).not.toBe(SIGNER_MODE.mac);
  });
});

describe("sign-to-derive: failure + format handling", () => {
  it("does NOT cache a rejected derivation — a transient signTypedData failure is retryable", async () => {
    let calls = 0;
    const account = privateKeyToAccount(PK);
    const goodSig = await account.signTypedData({
      domain: { name: "AgentKV Encryption", version: "1" },
      types: {
        Derive: [
          { name: "purpose", type: "string" },
          { name: "version", type: "string" },
        ],
      },
      primaryType: "Derive",
      message: { purpose: "encryption-key", version: "v1" },
    });
    const flakySigner = {
      address: account.address,
      signMessage: account.signMessage,
      signTypedData: async () => {
        calls++;
        if (calls === 1) throw new Error("user dismissed the wallet prompt");
        return goodSig;
      },
    };
    const kv = new AgentKV({ signer: flakySigner as any, endpoint: ENDPOINT });
    await expect((kv as any).getKeyMaterial()).rejects.toThrow(/dismissed/); // first call fails...
    const km = await (kv as any).getKeyMaterial(); // ...the retry succeeds (memo was cleared)
    expect(km.value.length).toBe(32);
    expect(calls).toBe(2);
  });

  it("rejects a signer whose derivation signature is not 65 bytes (unstable for derivation)", async () => {
    const shortSigner = {
      address: privateKeyToAccount(PK).address,
      signMessage: privateKeyToAccount(PK).signMessage,
      // 64-byte EIP-2098 compact-ish blob (no v byte) — a different serialization would
      // silently rotate the key, so it must be rejected, not accepted.
      signTypedData: async () => `0x${"11".repeat(64)}` as `0x${string}`,
    };
    const kv = new AgentKV({ signer: shortSigner as any, endpoint: ENDPOINT });
    await expect((kv as any).getKeyMaterial()).rejects.toThrow(/65-byte EIP-712/);
  });
});
