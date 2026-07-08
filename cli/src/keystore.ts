import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { generateAccountKey, isAccountKeyFormat } from "@agentkv/client";
import { bytesToHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// Frictionless onboarding: with no AGENTKV_PRIVATE_KEY set, the CLI / MCP server mints a
// local wallet on first use and reuses it thereafter — so an agent "just works" with its
// own signable wallet, no setup. The key IS the agent's identity + namespace and holds its
// funds, so it's persisted to a 0600 file inside a 0700 dir (POSIX). The location is
// ~/.agentkv/wallet.json (next to config.json); override the base dir with AGENTKV_HOME.

const POSIX = process.platform !== "win32";
const KEY_RE = /^0x[0-9a-fA-F]{64}$/;

export interface StoredWallet {
  privateKey: `0x${string}`;
  address: `0x${string}`;
  path: string;
  created: boolean;
}

/** Base directory for AgentKV local state (override with AGENTKV_HOME). */
export function agentkvDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AGENTKV_HOME?.trim();
  return override ? override : join(homedir(), ".agentkv");
}

export function walletPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(agentkvDir(env), "wallet.json");
}

export function accountPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(agentkvDir(env), "account.json");
}

/** Create the AgentKV dir as 0700 (POSIX). Best-effort chmod; the 0600 file is the guard. */
function ensureDir(env: NodeJS.ProcessEnv): void {
  const dir = agentkvDir(env);
  mkdirSync(dir, { recursive: true, mode: POSIX ? 0o700 : undefined });
  if (POSIX) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // dir perms are best-effort; the 0600 file is the primary guard
    }
  }
}

/** Write a JSON keystore file create-exclusive (wx) at mode 0600 (POSIX), defeating umask. */
function writeKeystoreFile(file: string, body: unknown): void {
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  if (POSIX) {
    try {
      chmodSync(file, 0o600);
    } catch {
      // best-effort; wx already created it with mode 0o600 above
    }
  }
}

function readKey(file: string): `0x${string}` | null {
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as { privateKey?: unknown };
    return typeof j.privateKey === "string" && KEY_RE.test(j.privateKey)
      ? (j.privateKey as `0x${string}`)
      : null;
  } catch {
    return null;
  }
}

/** The stored wallet's public address + path, or null if none exists. Never creates one. */
export function peekStoredWallet(
  env: NodeJS.ProcessEnv = process.env,
): { address: `0x${string}`; path: string } | null {
  const file = walletPath(env);
  const key = readKey(file);
  return key ? { address: privateKeyToAccount(key).address, path: file } : null;
}

/** Return the agent's local AgentKV wallet, minting + persisting one on the first call. */
export function getOrCreateStoredWallet(env: NodeJS.ProcessEnv = process.env): StoredWallet {
  const file = walletPath(env);
  const existing = readKey(file);
  if (existing) {
    return {
      privateKey: existing,
      address: privateKeyToAccount(existing).address,
      path: file,
      created: false,
    };
  }
  ensureDir(env);
  const privateKey = generatePrivateKey();
  const address = privateKeyToAccount(privateKey).address;
  try {
    // create-exclusive (wx): a concurrent first-run cannot clobber an already-minted key.
    writeKeystoreFile(file, { address, privateKey });
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "EEXIST") {
      const k = readKey(file);
      if (k)
        return {
          privateKey: k,
          address: privateKeyToAccount(k).address,
          path: file,
          created: false,
        };
    }
    throw e;
  }
  return { privateKey, address, path: file, created: true };
}

// ── Account-key mode ──────────────────────────────────────────────────────────
// A managed account (e.g. an awal-funded wallet that cannot sign) authenticates with
// an opaque `ak_…` bearer token + a LOCAL 32-byte AES encryption key. BOTH are
// unrecoverable secrets (the worker stores only the bearer's hash). Unlike the wallet,
// the account is NOT auto-provisioned — it must be funded by a real >=$1 deposit — so
// creation is OPT-IN (an explicit `agentkv account new`), never on read.

const ENC_RE = /^0x[0-9a-fA-F]{64}$/;

export interface StoredAccount {
  /** The raw `ak_…` bearer token — the account's identity + namespace (server hashes it). */
  accountKey: string;
  /** The 32-byte local AES key as 0x-hex; there is no wallet to derive one from. */
  encryptionKey: `0x${string}`;
  path: string;
}

/**
 * The stored account (key + enc key) + path. Never creates one.
 *
 * Distinguishes ABSENT from CORRUPT so a namespace switch can never happen silently:
 *   - file ABSENT (ENOENT)        -> returns null (callers fall through to wallet mode)
 *   - file PRESENT but malformed  -> THROWS (bad JSON, or a bad accountKey/encryptionKey)
 *
 * A malformed account.json used to also return null, so `clientFromConfig` silently fell
 * through to WALLET mode — a namespace switch that strands the funded account's credits and
 * writes to the wrong namespace with NO error. Throwing lets callers surface a clear config
 * error instead of quietly picking a different identity.
 */
export function peekStoredAccount(env: NodeJS.ProcessEnv = process.env): StoredAccount | null {
  const file = accountPath(env);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    // Genuinely absent (file or its parent dir) -> not account mode. Any OTHER read error
    // (e.g. EACCES) surfaces rather than being mistaken for "no account".
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw e;
  }
  let j: { accountKey?: unknown; encryptionKey?: unknown };
  try {
    j = JSON.parse(raw);
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
  if (!isAccountKeyFormat(j.accountKey)) {
    throw new Error(
      `${file} has a missing or malformed accountKey (expected ak_<64 lowercase hex>)`,
    );
  }
  if (typeof j.encryptionKey !== "string" || !ENC_RE.test(j.encryptionKey)) {
    throw new Error(
      `${file} has a missing or malformed encryptionKey (expected 0x followed by 64 hex chars)`,
    );
  }
  return { accountKey: j.accountKey, encryptionKey: j.encryptionKey as `0x${string}`, path: file };
}

/**
 * Mint a fresh account (a new `ak_…` bearer + a random 32-byte local AES key) and
 * persist it to ~/.agentkv/account.json with the same 0600 / 0700-dir / create-exclusive
 * treatment as the wallet keystore. Refuses to clobber an existing account file (wx).
 */
export function createStoredAccount(env: NodeJS.ProcessEnv = process.env): StoredAccount {
  const file = accountPath(env);
  ensureDir(env);
  const accountKey = generateAccountKey();
  // viem's bytesToHex is already 0x-prefixed lowercase — exactly the enc-key format.
  const encryptionKey = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  // create-exclusive (wx): never clobber an already-provisioned account.
  writeKeystoreFile(file, { accountKey, encryptionKey });
  return { accountKey, encryptionKey, path: file };
}
