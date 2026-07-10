import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentKVError } from "@agentkv/client";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { clientFromConfig } from "../src/config";
import {
  accountPath,
  createStoredAccount,
  getOrCreateStoredWallet,
  peekStoredAccount,
  peekStoredWallet,
  walletPath,
} from "../src/keystore";

function tmpEnv(): NodeJS.ProcessEnv {
  return { AGENTKV_HOME: mkdtempSync(join(tmpdir(), "agentkv-ks-")) };
}
const clean = (env: NodeJS.ProcessEnv) =>
  rmSync(env.AGENTKV_HOME as string, { recursive: true, force: true });

describe("keystore", () => {
  it("mints a wallet on first call, then reuses it (idempotent)", () => {
    const env = tmpEnv();
    try {
      expect(peekStoredWallet(env)).toBeNull();
      const a = getOrCreateStoredWallet(env);
      expect(a.created).toBe(true);
      expect(a.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(a.privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);

      const b = getOrCreateStoredWallet(env);
      expect(b.created).toBe(false);
      expect(b.privateKey).toBe(a.privateKey); // same wallet, not a fresh one
      expect(peekStoredWallet(env)?.address).toBe(a.address);
    } finally {
      clean(env);
    }
  });

  it.skipIf(process.platform === "win32")("persists the key file as 0600", () => {
    const env = tmpEnv();
    try {
      getOrCreateStoredWallet(env);
      expect(statSync(walletPath(env)).mode & 0o777).toBe(0o600);
    } finally {
      clean(env);
    }
  });

  it("first-run EEXIST recovery: a valid racer file is adopted (created:false), never the loser's key", () => {
    const env = tmpEnv();
    try {
      // A concurrent first run: a racing process has already minted + persisted a VALID wallet
      // at wallet.json. Because readKey() succeeds, getOrCreateStoredWallet adopts THAT key
      // (created:false) instead of minting a competing one — the same identity the caller would
      // fund. (The wx-write EEXIST branch is the same recovery for the readKey()==null-at-first
      // interleaving; covered below.)
      const competitorKey = generatePrivateKey();
      const competitorAddr = privateKeyToAccount(competitorKey).address;
      writeFileSync(
        walletPath(env),
        `${JSON.stringify({ address: competitorAddr, privateKey: competitorKey }, null, 2)}\n`,
      );
      const w = getOrCreateStoredWallet(env);
      expect(w.created).toBe(false);
      expect(w.privateKey).toBe(competitorKey); // adopts the winner, never mints a losing key
    } finally {
      clean(env);
    }
  });

  it("first-run EEXIST recovery: a CORRUPT racer file re-read as null rethrows EEXIST (never a losing key)", () => {
    const env = tmpEnv();
    try {
      // Force the wx-write EEXIST branch: a file exists whose privateKey is unreadable, so the
      // initial readKey() returns null (proceed to write), the wx write throws EEXIST, and the
      // recovery re-read ALSO returns null — which must rethrow, NOT silently return the local
      // losing keypair. This pins the catch(EEXIST) → throw-e sub-path (previously untested).
      writeFileSync(walletPath(env), JSON.stringify({ privateKey: "not-a-valid-key" }));
      let err: NodeJS.ErrnoException | undefined;
      try {
        getOrCreateStoredWallet(env);
      } catch (e) {
        err = e as NodeJS.ErrnoException;
      }
      expect(err?.code).toBe("EEXIST"); // rethrown, not swallowed into a losing key
    } finally {
      clean(env);
    }
  });

  it("clientFromConfig auto-provisions when no key is set, and notifies once", () => {
    const env = tmpEnv();
    try {
      const cfg = { endpoint: "https://x.example", network: "eip155:8453" };
      let firstNotice = "";
      const client = clientFromConfig(cfg, { env, notify: (m) => (firstNotice = m) });
      expect(client.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(firstNotice).toContain(client.address); // the notice names the new wallet

      let secondNotice = "";
      const c2 = clientFromConfig(cfg, { env, notify: (m) => (secondNotice = m) });
      expect(c2.address).toBe(client.address); // same wallet reused
      expect(secondNotice).toBe(""); // not "created" again → no notice
    } finally {
      clean(env);
    }
  });
});

describe("keystore — account file", () => {
  it("creates an account file with a valid ak_ key + 32-byte enc key; peek reads it back", () => {
    const env = tmpEnv();
    try {
      expect(peekStoredAccount(env)).toBeNull(); // never auto-created
      const a = createStoredAccount(env);
      expect(a.accountKey).toMatch(/^ak_[0-9a-f]{64}$/);
      expect(a.encryptionKey).toMatch(/^0x[0-9a-fA-F]{64}$/); // 32 bytes as 0x-hex
      expect(a.path).toBe(accountPath(env));

      const peeked = peekStoredAccount(env);
      expect(peeked?.accountKey).toBe(a.accountKey);
      expect(peeked?.encryptionKey).toBe(a.encryptionKey);
    } finally {
      clean(env);
    }
  });

  it("refuses to clobber an existing account file (second create throws EEXIST)", () => {
    const env = tmpEnv();
    try {
      const first = createStoredAccount(env);
      let err: NodeJS.ErrnoException | undefined;
      try {
        createStoredAccount(env);
      } catch (e) {
        err = e as NodeJS.ErrnoException;
      }
      expect(err?.code).toBe("EEXIST"); // no clobber
      expect(peekStoredAccount(env)?.accountKey).toBe(first.accountKey); // unchanged
    } finally {
      clean(env);
    }
  });

  it.skipIf(process.platform === "win32")("persists the account file as 0600", () => {
    const env = tmpEnv();
    try {
      createStoredAccount(env);
      expect(statSync(accountPath(env)).mode & 0o777).toBe(0o600);
    } finally {
      clean(env);
    }
  });

  // FIX 1: peek must distinguish ABSENT (null) from PRESENT-but-CORRUPT (throw), so a
  // malformed file can't be mistaken for "no account" and silently switch namespaces.
  it("absent account.json → null; present-but-corrupt → throws (never null)", () => {
    const env = tmpEnv();
    try {
      expect(peekStoredAccount(env)).toBeNull(); // genuinely absent

      // Not valid JSON.
      writeFileSync(accountPath(env), "{ not json");
      expect(() => peekStoredAccount(env)).toThrow(/valid JSON/);

      // Valid JSON, bad accountKey.
      writeFileSync(
        accountPath(env),
        JSON.stringify({ accountKey: "nope", encryptionKey: `0x${"a".repeat(64)}` }),
      );
      expect(() => peekStoredAccount(env)).toThrow(/accountKey/);

      // Valid JSON + good accountKey, bad encryptionKey.
      writeFileSync(
        accountPath(env),
        JSON.stringify({ accountKey: `ak_${"a".repeat(64)}`, encryptionKey: "0xshort" }),
      );
      expect(() => peekStoredAccount(env)).toThrow(/encryptionKey/);
    } finally {
      clean(env);
    }
  });
});

describe("clientFromConfig — account-mode auto-detect", () => {
  const cfgBase = { endpoint: "https://x.example", network: "eip155:8453" } as const;
  const AK = `ak_${"a".repeat(64)}`;
  const ENC = `0x${"b".repeat(64)}` as `0x${string}`;

  it("AGENTKV_ACCOUNT_KEY + AGENTKV_ENCRYPTION_KEY env → account-mode client (bearer, no signer)", () => {
    const env = tmpEnv();
    try {
      const client = clientFromConfig({ ...cfgBase, accountKey: AK, encryptionKey: ENC }, { env });
      expect((client as any).accountKey).toBe(AK); // raw bearer is the identity
      expect((client as any).signer).toBeUndefined(); // managed account can't sign
      expect(client.address).toBeUndefined(); // no wallet address in account-key mode
    } finally {
      clean(env);
    }
  });

  it("an account.json file (and no AGENTKV_PRIVATE_KEY env) → account-mode client", () => {
    const env = tmpEnv();
    try {
      const acct = createStoredAccount(env);
      const client = clientFromConfig({ ...cfgBase }, { env });
      expect((client as any).accountKey).toBe(acct.accountKey); // picked up from the file
      expect((client as any).signer).toBeUndefined();
    } finally {
      clean(env);
    }
  });

  it("AGENTKV_PRIVATE_KEY env wins over an existing account.json (wallet mode)", () => {
    const env = tmpEnv();
    try {
      createStoredAccount(env); // account file present...
      const client = clientFromConfig({ ...cfgBase, privateKey: `0x${"c".repeat(64)}` }, { env });
      expect((client as any).accountKey).toBeUndefined(); // ...but env privkey wins
      expect((client as any).signer).toBeDefined(); // wallet mode → a signer
    } finally {
      clean(env);
    }
  });

  it("no account env/file → existing wallet path (auto-provisioned signer)", () => {
    const env = tmpEnv();
    try {
      const client = clientFromConfig({ ...cfgBase }, { env });
      expect((client as any).accountKey).toBeUndefined();
      expect((client as any).signer).toBeDefined(); // auto-provisioned wallet has a signer
      expect(client.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    } finally {
      clean(env);
    }
  });

  it("account env set but encryptionKey missing → clear config error", () => {
    const env = tmpEnv();
    try {
      expect(() => clientFromConfig({ ...cfgBase, accountKey: AK }, { env })).toThrow(
        /AGENTKV_ENCRYPTION_KEY/,
      );
    } finally {
      clean(env);
    }
  });

  it("malformed AGENTKV_ACCOUNT_KEY → clear config error", () => {
    const env = tmpEnv();
    try {
      expect(() =>
        clientFromConfig({ ...cfgBase, accountKey: "ak_not-hex", encryptionKey: ENC }, { env }),
      ).toThrow(/ak_<64 lowercase hex>/);
    } finally {
      clean(env);
    }
  });

  // FIX 1(a): a genuinely-absent account.json (and no account env) still falls through to
  // wallet mode, UNCHANGED — auto-provisioning a signable wallet.
  it("absent account.json + no account env → wallet mode (auto-provisioned signer), no throw", () => {
    const env = tmpEnv();
    try {
      const client = clientFromConfig({ ...cfgBase }, { env });
      expect((client as any).accountKey).toBeUndefined();
      expect((client as any).signer).toBeDefined();
    } finally {
      clean(env);
    }
  });

  // FIX 1(b): a present-but-CORRUPT account.json must THROW a clear config error — NOT
  // silently fall through to wallet mode (a namespace switch that strands the account's
  // credits and writes to the wrong namespace).
  it("present-but-corrupt account.json → throws invalid_config (does NOT silently use a wallet)", () => {
    const env = tmpEnv();
    try {
      writeFileSync(
        accountPath(env),
        JSON.stringify({ accountKey: "not-an-ak-key", encryptionKey: `0x${"a".repeat(64)}` }),
      );
      let thrown: unknown;
      try {
        clientFromConfig({ ...cfgBase }, { env });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(AgentKVError);
      expect((thrown as AgentKVError).code).toBe("invalid_config");
      expect((thrown as Error).message).toMatch(/corrupt/i);
      // It did NOT fall through to wallet mode: no wallet was auto-provisioned.
      expect(peekStoredWallet(env)).toBeNull();
    } finally {
      clean(env);
    }
  });

  // A corrupt account.json is IGNORED when AGENTKV_PRIVATE_KEY is set — an explicit wallet
  // key wins outright, so a broken file must not block the run.
  it("corrupt account.json but AGENTKV_PRIVATE_KEY set → wallet mode wins (file untouched, no throw)", () => {
    const env = tmpEnv();
    try {
      writeFileSync(accountPath(env), "{ not json");
      const client = clientFromConfig({ ...cfgBase, privateKey: `0x${"c".repeat(64)}` }, { env });
      expect((client as any).accountKey).toBeUndefined();
      expect((client as any).signer).toBeDefined();
    } finally {
      clean(env);
    }
  });

  // A minted account.json is this CLI's own file — it can't be a typo — so it auto-authorizes
  // pay-per-call bootstrap even with no AGENTKV_BOOTSTRAP env set.
  it("stored-file account key (no AGENTKV_ACCOUNT_KEY env) auto-authorizes bootstrap", () => {
    const env = tmpEnv();
    try {
      createStoredAccount(env);
      const client = clientFromConfig({ ...cfgBase }, { env });
      expect((client as any).bootstrap).toBe(true);
    } finally {
      clean(env);
    }
  });

  // An env-supplied AGENTKV_ACCOUNT_KEY stays opt-in for bootstrap, even if a minted
  // account.json also happens to be present — env/config is where typos live.
  it("env AGENTKV_ACCOUNT_KEY does NOT auto-authorize bootstrap, even with an account.json present", () => {
    const env = tmpEnv();
    try {
      createStoredAccount(env);
      const client = clientFromConfig({ ...cfgBase, accountKey: AK, encryptionKey: ENC }, { env });
      expect((client as any).bootstrap).toBe(false);
    } finally {
      clean(env);
    }
  });
});
