import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AgentKV, AgentKVError, isAccountKeyFormat } from "@agentkv/client";
import { privateKeyToAccount } from "viem/accounts";
import { awalTopoffPayer } from "./awal";
import { awalInlinePayer } from "./awalInline";
import { agentkvDir, getOrCreateStoredWallet, peekStoredAccount } from "./keystore";

/**
 * Hosted AgentKV service — used when no endpoint is configured. This is a bare
 * host, not a versioned path: clientFromConfig never sets `apiVersion`, so
 * every CLI-built client inherits `@agentkv/client`'s `"1"` default and
 * targets this host's `/v1/*` routes (see AgentKV.route()/kvRoute() in
 * client/src/index.ts). The pre-`/v1` legacy paths remain supported by the
 * worker, but the CLI has no knob to opt into them.
 */
const DEFAULT_ENDPOINT = "https://api.agentx402.ai";

export interface ResolvedConfig {
  endpoint: string;
  network: string;
  maxSpendUsd?: number;
  maxSessionSpendUsd?: number;
  privateKey?: `0x${string}`;
  encryptionKey?: `0x${string}`;
  /** The raw `ak_…` account bearer from AGENTKV_ACCOUNT_KEY (account-key mode). */
  accountKey?: string;
  /**
   * Selected card→USDC onramp provider id (e.g. "coinbase"). Always populated by
   * resolveConfig (default "coinbase"); optional on the type so callers that hand-build a
   * minimal ResolvedConfig for clientFromConfig (which ignores onramp) need not set it.
   */
  onrampProvider?: string;
  /** Provider config bag (e.g. Coinbase `appId`). Values may be undefined. */
  onrampConfig?: Record<string, string | undefined>;
  /** Auto top-off payer id from AGENTKV_TOPOFF ("awal" is the only recognized value). */
  topoff?: string;
  /** Prepay watermark (USD) from AGENTKV_PREPAY_WATERMARK; only used with `topoff`. */
  prepayWatermarkUsd?: number;
  /** Prepay top-off amount (USD) from AGENTKV_PREPAY_TOPOFF; only used with `topoff`. */
  prepayTopoffUsd?: number;
  /** Inline pay-per-op payer id from AGENTKV_INLINE ("awal" is the only recognized value). */
  inline?: string;
}

type Flags = {
  endpoint?: string;
  network?: string;
  maxSpendUsd?: number;
  onrampProvider?: string;
  onrampAppId?: string;
};
type Env = Record<string, string | undefined>;
type ConfigFile = Partial<{
  endpoint: string;
  network: string;
  maxSpendUsd: number;
  onrampProvider: string;
  onrampAppId: string;
}>;
type FileReader = () => ConfigFile | null;

/**
 * Read the on-disk config file (`<AGENTKV_HOME|~/.agentkv>/config.json`) written by
 * `agentkv config`, tolerating absence / bad JSON / permission errors by returning null.
 * This is the DEFAULT FileReader used by every production caller of resolveConfig — without
 * it, `agentkv config` was write-only: everything it persisted (endpoint, spend cap) was
 * silently ignored, so a user who ran `agentkv config --endpoint http://localhost:8787`
 * still hit the production default and paid real USDC there.
 */
export function readConfigFile(env: Env = process.env): ConfigFile | null {
  try {
    const parsed = JSON.parse(
      readFileSync(join(agentkvDir(env as NodeJS.ProcessEnv), "config.json"), "utf8"),
    );
    return parsed && typeof parsed === "object" ? (parsed as ConfigFile) : null;
  } catch {
    return null; // ENOENT / invalid JSON / EACCES -> no file config
  }
}

export function resolveConfig(
  flags: Flags,
  env: Env,
  // Defaults to () => null so unit tests are deterministic (no ambient ~/.agentkv/config.json).
  // Every PRODUCTION caller passes () => readConfigFile(env) so the on-disk config is honored.
  readFile: FileReader = () => null,
): ResolvedConfig {
  const file = readFile() ?? {};
  // Treat empty-string env vars as unset. A plugin MCP `env` block substitutes an
  // unset optional `${user_config.x:-}` to an EMPTY string, so "" must mean "not
  // provided" — otherwise e.g. an empty AGENTKV_MAX_SPEND_USD would parse to a $0
  // cap that refuses every paid op, and an empty AGENTKV_NETWORK would blank the default.
  // Defaults to the hosted service so users of the one hosted endpoint don't have to set
  // it; override via --endpoint / AGENTKV_ENDPOINT / config when needed.
  const endpoint =
    flags.endpoint ?? envStr(env.AGENTKV_ENDPOINT) ?? file.endpoint ?? DEFAULT_ENDPOINT;
  return {
    endpoint,
    network: flags.network ?? envStr(env.AGENTKV_NETWORK) ?? file.network ?? "eip155:8453",
    // Per-operation cap (throws on a single op above this).
    maxSpendUsd:
      flags.maxSpendUsd ??
      numOrThrow(env.AGENTKV_MAX_SPEND_USD, "AGENTKV_MAX_SPEND_USD") ??
      file.maxSpendUsd,
    // Cumulative, instance-lifetime cap — env-only, opt-in. Kept SEPARATE from the
    // per-op cap: the MCP server is one long-lived client, so coupling them would turn
    // a per-op ceiling into a lifetime budget that eventually blocks every op.
    maxSessionSpendUsd: numOrThrow(
      env.AGENTKV_MAX_SESSION_SPEND_USD,
      "AGENTKV_MAX_SESSION_SPEND_USD",
    ),
    // secrets: env ONLY — never flags or file
    privateKey: envStr(env.AGENTKV_PRIVATE_KEY) as `0x${string}` | undefined,
    encryptionKey: envStr(env.AGENTKV_ENCRYPTION_KEY) as `0x${string}` | undefined,
    accountKey: envStr(env.AGENTKV_ACCOUNT_KEY),
    // Onramp: flag > env > file > default, matching the precedence used above. The provider
    // is a string id resolved at use-time (getOnrampProvider) so config never imports the
    // provider classes — adding a provider doesn't touch this file.
    onrampProvider:
      flags.onrampProvider ??
      envStr(env.AGENTKV_ONRAMP_PROVIDER) ??
      file.onrampProvider ??
      "coinbase",
    // Provider config bag. Currently just Coinbase's appId; new keys go here without
    // changing the command. appId is non-secret (a public CDP project id) so it may come
    // from flag/env/file.
    onrampConfig: {
      appId: flags.onrampAppId ?? envStr(env.AGENTKV_ONRAMP_APP_ID) ?? file.onrampAppId,
    },
    // Account-key auto top-off: env-only. Validated at client construction
    // (clientFromConfig), where the auth mode is known.
    topoff: envStr(env.AGENTKV_TOPOFF),
    prepayWatermarkUsd: numOrThrow(env.AGENTKV_PREPAY_WATERMARK, "AGENTKV_PREPAY_WATERMARK"),
    prepayTopoffUsd: numOrThrow(env.AGENTKV_PREPAY_TOPOFF, "AGENTKV_PREPAY_TOPOFF"),
    // Inline pay-per-op transport: env-only, account-key mode only (validated at
    // client construction, same as `topoff`, where the auth mode is known).
    inline: envStr(env.AGENTKV_INLINE),
  };
}

/** Normalize an env var: undefined, empty, or whitespace-only -> undefined (trimmed). */
function envStr(s?: string): string | undefined {
  if (s === undefined) return undefined;
  const t = s.trim();
  return t === "" ? undefined : t;
}

/**
 * Parse a non-negative numeric env var. Unset/empty -> undefined (no cap — the
 * documented default). A set-but-malformed or negative value THROWS (fail closed):
 * a typo'd spend cap must not silently become "unlimited" on real funds.
 */
function numOrThrow(s: string | undefined, name: string): number | undefined {
  const v = envStr(s);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${name} must be a non-negative number (got ${JSON.stringify(v)})`);
  }
  return n;
}

function privateKeySigner(pk: `0x${string}`) {
  return privateKeyToAccount(pk);
}

export function clientFromConfig(
  cfg: ResolvedConfig,
  opts?: { notify?: (msg: string) => void; env?: NodeJS.ProcessEnv },
): AgentKV {
  // Per-op and cumulative-session caps are independent knobs (AGENTKV_MAX_SPEND_USD vs
  // AGENTKV_MAX_SESSION_SPEND_USD). The session cap is left unset unless explicitly
  // configured, so a per-op ceiling on a long-lived MCP server never silently becomes a
  // lifetime budget that blocks all ops once it's reached.
  const base = {
    endpoint: cfg.endpoint,
    network: cfg.network,
    maxSpendUsd: cfg.maxSpendUsd,
    maxSessionSpendUsd: cfg.maxSessionSpendUsd,
  };

  // Account-key mode (managed wallets that can't sign) is OPT-IN. It's selected iff:
  //   (AGENTKV_ACCOUNT_KEY env is set) OR (an account.json file exists AND no
  //    AGENTKV_PRIVATE_KEY env is set).
  // i.e. an explicit wallet key (AGENTKV_PRIVATE_KEY) always wins over a stored account
  // file, but an explicit AGENTKV_ACCOUNT_KEY env wins outright. When neither holds we
  // fall through to the existing wallet path (env key, else auto-provisioned wallet).
  // Only read account.json when it would actually be used: an explicit AGENTKV_ACCOUNT_KEY
  // (cfg.accountKey) or AGENTKV_PRIVATE_KEY (cfg.privateKey) both win over the file, so with
  // either set we never touch it (a corrupt file must not block an explicit-key run). A file
  // that EXISTS-but-is-malformed THROWS out of peekStoredAccount; surface that as a clear
  // config error rather than silently falling through to wallet mode (which would switch
  // namespaces and strand the funded account's credits).
  let stored: ReturnType<typeof peekStoredAccount> = null;
  if (!cfg.accountKey && !cfg.privateKey) {
    try {
      stored = peekStoredAccount(opts?.env);
    } catch (e) {
      throw new AgentKVError(
        `account.json is corrupt: ${e instanceof Error ? e.message : String(e)}; ` +
          "fix or remove it (or set AGENTKV_ACCOUNT_KEY / AGENTKV_PRIVATE_KEY explicitly)",
        "invalid_config",
        0,
      );
    }
  }
  const accountKey = cfg.accountKey ?? (cfg.privateKey ? undefined : stored?.accountKey);
  if (accountKey) {
    if (!isAccountKeyFormat(accountKey)) {
      throw new Error(
        "AGENTKV_ACCOUNT_KEY must be of the form ak_<64 lowercase hex> (run 'agentkv account new' to mint one)",
      );
    }
    // Account mode has no wallet to derive an AES key from — the local encryption key is
    // REQUIRED. From env it's AGENTKV_ENCRYPTION_KEY; from a file it's stored alongside.
    const encryptionKey = cfg.accountKey ? cfg.encryptionKey : stored?.encryptionKey;
    if (!encryptionKey) {
      throw new Error(
        cfg.accountKey
          ? "account-key mode (AGENTKV_ACCOUNT_KEY) requires AGENTKV_ENCRYPTION_KEY (the local 32-byte AES key)"
          : "account.json is missing or has a malformed encryptionKey (the local 32-byte AES key)",
      );
    }
    // Auto top-off (account-key only). AGENTKV_TOPOFF=awal turns on prepay with a
    // payer hook that shells to `npx awal x402 pay …/account/deposit`. Prepay
    // amounts default to watermark $0.50 / top-off $1 (the server deposit minimum),
    // refined by AGENTKV_PREPAY_WATERMARK / AGENTKV_PREPAY_TOPOFF. Fail closed on
    // config that would otherwise be silently inert.
    if (cfg.topoff !== undefined && cfg.topoff !== "awal") {
      throw new AgentKVError(
        `AGENTKV_TOPOFF: unrecognized value ${JSON.stringify(cfg.topoff)} (only "awal" is supported)`,
        "invalid_config",
        0,
      );
    }
    if (
      cfg.topoff === undefined &&
      (cfg.prepayWatermarkUsd !== undefined || cfg.prepayTopoffUsd !== undefined)
    ) {
      throw new AgentKVError(
        "AGENTKV_PREPAY_WATERMARK/AGENTKV_PREPAY_TOPOFF require AGENTKV_TOPOFF=awal",
        "invalid_config",
        0,
      );
    }
    // Inline pay-per-op (account-key only). AGENTKV_INLINE=awal wires a payer hook
    // that shells to `npx awal x402 pay …/kv/<digest>` for the WHOLE op instead of a
    // stage-1 deposit top-off — opt-in, no `prepay` required (pay-per-op). Mutually
    // exclusive PER OP with `topoffPayer` at the SDK layer (topoffPayer always wins
    // when both are configured, client/README.md); the CLI still wires both hooks
    // when both env vars are set, matching that documented precedence rather than
    // second-guessing it here.
    if (cfg.inline !== undefined && cfg.inline !== "awal") {
      throw new AgentKVError(
        `AGENTKV_INLINE: unrecognized value ${JSON.stringify(cfg.inline)} (only "awal" is supported)`,
        "invalid_config",
        0,
      );
    }
    const opInlinePayer = cfg.inline === "awal" ? awalInlinePayer() : undefined;
    if (cfg.topoff === "awal") {
      return new AgentKV({
        ...base,
        accountKey,
        encryptionKey,
        prepay: {
          watermark: cfg.prepayWatermarkUsd ?? 0.5,
          topoff: cfg.prepayTopoffUsd ?? 1,
        },
        topoffPayer: awalTopoffPayer(),
        ...(opInlinePayer ? { opInlinePayer } : {}),
      });
    }
    return new AgentKV({
      ...base,
      accountKey,
      encryptionKey,
      ...(opInlinePayer ? { opInlinePayer } : {}),
    });
  }

  // AGENTKV_TOPOFF / AGENTKV_INLINE are account-key-mode only: wallet mode signs its
  // own x402 payments (challenges and top-offs alike).
  if (
    cfg.topoff !== undefined ||
    cfg.prepayWatermarkUsd !== undefined ||
    cfg.prepayTopoffUsd !== undefined ||
    cfg.inline !== undefined
  ) {
    throw new AgentKVError(
      "AGENTKV_TOPOFF / AGENTKV_PREPAY_* / AGENTKV_INLINE apply to account-key mode only (wallet mode pays its own top-offs)",
      "invalid_config",
      0,
    );
  }

  let privateKey = cfg.privateKey;
  if (!privateKey) {
    // Frictionless onboarding: no key configured -> mint/reuse a local wallet so the agent
    // "just works" on first run with its own signable wallet. (The created notice goes to
    // the caller's `notify`, which MUST be stderr on the MCP path — stdout is the protocol.)
    const w = getOrCreateStoredWallet(opts?.env);
    privateKey = w.privateKey;
    if (w.created) {
      opts?.notify?.(
        `created a new wallet ${w.address} (saved to ${w.path}). It is your namespace and holds your funds — fund it, then back it up. View it any time with: agentkv wallet show`,
      );
    }
  }
  return cfg.encryptionKey
    ? new AgentKV({
        ...base,
        signer: privateKeySigner(privateKey),
        encryptionKey: cfg.encryptionKey,
      })
    : new AgentKV({ ...base, privateKey });
}
