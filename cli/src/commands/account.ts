import { AgentKV, isAccountKeyFormat } from "@agentkv/client";
import { privateKeyToAccount } from "viem/accounts";
import { parseFlags } from "../args";
import { readConfigFile, resolveConfig } from "../config";
import {
  accountPath,
  createStoredAccount,
  getOrCreateStoredWallet,
  peekStoredAccount,
  peekStoredWallet,
} from "../keystore";
import { EXIT, printError, printJson, type Writer } from "../output";

const PAYER_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Resolve the PAYER private key that funds an account deposit, deliberately
 * INDEPENDENT of the configured account (the owner). Precedence:
 *   --from-key <0xhex>  >  AGENTKV_PAYER_KEY  >  AGENTKV_PRIVATE_KEY  >  wallet.json
 * The first NON-EMPTY source is authoritative: if it is malformed we THROW rather
 * than silently fall through to a different wallet (a typo'd payer key must not
 * quietly spend from wallet.json). The stored wallet is used ONLY if it already
 * exists — funding never auto-provisions a (brand-new, empty) wallet. Returns
 * undefined when no payer is resolvable. The raw key is never logged.
 */
function resolvePayerKey(
  flags: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): `0x${string}` | undefined {
  const explicit =
    (typeof flags.fromKey === "string" ? flags.fromKey.trim() : "") ||
    env.AGENTKV_PAYER_KEY?.trim() ||
    env.AGENTKV_PRIVATE_KEY?.trim() ||
    "";
  if (explicit) {
    if (!PAYER_KEY_RE.test(explicit)) {
      throw new Error(
        "payer key must be a 0x-prefixed 32-byte hex private key " +
          "(from --from-key / AGENTKV_PAYER_KEY / AGENTKV_PRIVATE_KEY)",
      );
    }
    return explicit as `0x${string}`;
  }
  // Stored wallet.json — only if it ALREADY exists (peek returns null otherwise), so
  // funding never mints a fresh, unfunded wallet as a side effect.
  if (peekStoredWallet(env)) return getOrCreateStoredWallet(env).privateKey;
  return undefined;
}

// `agentkv account` — opt-in account-key mode for MANAGED wallets that cannot sign
// (e.g. awal). An account authenticates with an opaque `ak_…` bearer token + a LOCAL
// 32-byte AES key. BOTH are unrecoverable secrets (the worker stores only the bearer's
// hash). Unlike the auto-provisioned wallet, an account is NOT auto-created — it must be
// funded by a real >=$1 deposit — so creation is explicit (`account new`), then funded.

export async function runAccount(
  args: string[],
  io: { client?: any; stdout: Writer; stderr: Writer; env?: NodeJS.ProcessEnv },
): Promise<number> {
  const sub = args[0];
  const env = io.env ?? process.env;
  // Resolve the endpoint the same way `fund` does (--endpoint / config file / env), not
  // just AGENTKV_ENDPOINT — the funding note must point at the SAME server the user is
  // targeting, or real USDC could be deposited to the wrong (default-production) namespace.
  const { flags, positionals } = parseFlags(args);
  const cfg = resolveConfig(flags, env, () => readConfigFile(env));

  if (sub === "new") {
    // Mint a fresh account + local enc key. Refuse to clobber an existing file (wx).
    let acct: ReturnType<typeof createStoredAccount>;
    try {
      acct = createStoredAccount(env);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "EEXIST") {
        printError(
          io.stderr,
          "account_exists",
          // accountPath (not peekStoredAccount) so a present-but-CORRUPT file — which now
          // throws from peek — still yields a clean "already exists" message, not a crash.
          `an account already exists at ${accountPath(env)}; delete it first to replace it`,
        );
        return EXIT.GENERIC;
      }
      throw e;
    }
    // Print the secrets ONCE — they are unrecoverable. The note tells the user how to fund.
    printJson(io.stdout, {
      accountKey: acct.accountKey,
      encryptionKey: acct.encryptionKey,
      path: acct.path,
      note:
        "Back up these — they are UNRECOVERABLE (the server stores only a hash of the account key). " +
        `Fund this account by depositing >=$1 to ${cfg.endpoint}/account/deposit from a wallet that can sign ` +
        "(e.g. awal). To buy USDC with a card for such a signing wallet, run `agentkv fund`.",
    });
    return EXIT.OK;
  }

  if (sub === "show") {
    // --reveal prints the raw secrets (for backup); without it, secrets stay hidden —
    // like `wallet show` prints the address, not the private key.
    const reveal = args.includes("--reveal");

    // Precedence mirrors clientFromConfig: an explicit AGENTKV_ACCOUNT_KEY env is the
    // highest-precedence account source (it wins even over a stored file), so `show` must
    // report account mode from env even when no account.json exists. Otherwise, an
    // env-configured account would misleadingly report "no account". Fall back to the file.
    const envAccountKey = cfg.accountKey; // trimmed by resolveConfig; undefined if empty
    // A SET-but-malformed AGENTKV_ACCOUNT_KEY is an ERROR, mirroring clientFromConfig —
    // NOT "absent". Silently falling back to the file (as before) would misleadingly report
    // the file account as configured while the env the user actually set is a broken key.
    // (An UNSET env var still falls back to the file, below.)
    if (envAccountKey !== undefined && !isAccountKeyFormat(envAccountKey)) {
      printError(
        io.stderr,
        "invalid_config",
        "AGENTKV_ACCOUNT_KEY must be of the form ak_<64 lowercase hex> (run 'agentkv account new' to mint one)",
      );
      return EXIT.GENERIC;
    }
    const envAccount = envAccountKey
      ? { accountKey: envAccountKey, encryptionKey: cfg.encryptionKey }
      : null;
    const stored = envAccount ? null : peekStoredAccount(env);

    if (!envAccount && !stored) {
      printJson(io.stdout, {
        configured: false,
        note: "No account yet — run 'agentkv account new' to mint one (account-key mode is opt-in).",
      });
      return EXIT.OK;
    }

    if (reveal) {
      if (envAccount) {
        // Env source: the raw key is already in the environment — echo it (with --reveal)
        // for backup, alongside the local encryption key if one is configured.
        printJson(io.stdout, {
          source: "AGENTKV_ACCOUNT_KEY env",
          accountKey: envAccount.accountKey,
          encryptionKey: envAccount.encryptionKey ?? null,
          note: "These come from the environment (AGENTKV_ACCOUNT_KEY / AGENTKV_ENCRYPTION_KEY).",
        });
        return EXIT.OK;
      }
      printJson(io.stdout, {
        source: "local account file",
        path: stored!.path,
        accountKey: stored!.accountKey,
        encryptionKey: stored!.encryptionKey,
        note: "These are unrecoverable secrets — store them somewhere safe.",
      });
      return EXIT.OK;
    }
    // Best-effort credit balance of the ACCOUNT being described — always from an
    // ACCOUNT-mode client, never a wallet's (mirroring clientFromConfig's precedence:
    // env key over file). We build the client HERE rather than trusting the one cli.ts
    // hands us: with AGENTKV_PRIVATE_KEY set, clientFromConfig would return a wallet-mode
    // client whose balance() reports the wrong (wallet) namespace, not this account's.
    // An injected client (tests) still wins. Building needs the local AES key (account
    // mode has no wallet to derive one); without it we skip the lookup rather than fail.
    const acctKey = envAccount?.accountKey ?? stored?.accountKey;
    const encKey = envAccount?.encryptionKey ?? stored?.encryptionKey;
    let balance: number | undefined;
    let balanceError: string | undefined;
    // Build the client INSIDE the try: a malformed env AGENTKV_ENCRYPTION_KEY makes the
    // AgentKV constructor throw, so constructing outside would crash `show` instead of
    // degrading to a balanceError. Now it degrades — `show` still prints the account
    // source/note with a balanceError, exit 0.
    try {
      const balanceClient: { balance(): Promise<number> } | undefined =
        io.client ??
        (acctKey && encKey
          ? new AgentKV({
              accountKey: acctKey,
              encryptionKey: encKey,
              endpoint: cfg.endpoint,
              network: cfg.network,
            })
          : undefined);
      if (balanceClient) {
        balance = await balanceClient.balance();
      }
    } catch (e) {
      balanceError = e instanceof Error ? e.message : String(e);
    }
    if (envAccount) {
      printJson(io.stdout, {
        configured: true,
        source: "AGENTKV_ACCOUNT_KEY env",
        note: "Account configured from the environment (AGENTKV_ACCOUNT_KEY). Its account key + encryption key are unrecoverable — back them up. Use --reveal to print them.",
        ...(balance !== undefined ? { balance } : {}),
        ...(balanceError ? { balanceError } : {}),
      });
      return EXIT.OK;
    }
    printJson(io.stdout, {
      source: "local account file",
      path: stored!.path,
      note: "Back up this file — its account key + encryption key are unrecoverable. Use --reveal to print them.",
      ...(balance !== undefined ? { balance } : {}),
      ...(balanceError ? { balanceError } : {}),
    });
    return EXIT.OK;
  }

  if (sub === "fund") {
    // `agentkv account fund <usd> [--from-key <0xhex>]` — "payer funds, bearer owns":
    // add prepaid credits to the CONFIGURED account (env AGENTKV_ACCOUNT_KEY > file)
    // by paying via x402 from a SEPARATE payer wallet. The account is the owner; the
    // payer just settles the on-chain deposit. Both are resolved independently.

    // 1) Amount: a whole number of US dollars >= $1 (matching fundAccount). Fail as
    //    USAGE up front, not after a round-trip. positionals[0] === "fund".
    const usd = Number(positionals[1]);
    if (!Number.isInteger(usd) || usd < 1) {
      printError(
        io.stderr,
        "usage",
        "account fund requires <usd> as a whole number of US dollars >= 1",
      );
      return EXIT.USAGE;
    }

    // 2) Configured account (env AGENTKV_ACCOUNT_KEY wins over the file), mirroring
    //    `account show` / clientFromConfig precedence. A SET-but-malformed env key errors.
    const envAccountKey = cfg.accountKey;
    if (envAccountKey !== undefined && !isAccountKeyFormat(envAccountKey)) {
      printError(
        io.stderr,
        "invalid_config",
        "AGENTKV_ACCOUNT_KEY must be of the form ak_<64 lowercase hex> (run 'agentkv account new' to mint one)",
      );
      return EXIT.GENERIC;
    }
    const envAccount = envAccountKey
      ? { accountKey: envAccountKey, encryptionKey: cfg.encryptionKey }
      : null;
    const stored = envAccount ? null : peekStoredAccount(env);
    const acctKey = envAccount?.accountKey ?? stored?.accountKey;
    const encKey = envAccount?.encryptionKey ?? stored?.encryptionKey;
    if (!acctKey) {
      printError(
        io.stderr,
        "no_account",
        "no account configured; run 'agentkv account new' or set AGENTKV_ACCOUNT_KEY (+ AGENTKV_ENCRYPTION_KEY)",
      );
      return EXIT.GENERIC;
    }

    // 3) Payer wallet (independent of the account). Malformed explicit key -> USAGE.
    let payerKey: `0x${string}` | undefined;
    try {
      payerKey = resolvePayerKey(flags, env);
    } catch (e) {
      printError(io.stderr, "invalid_payer", e instanceof Error ? e.message : String(e));
      return EXIT.USAGE;
    }
    if (!payerKey) {
      printError(
        io.stderr,
        "no_payer",
        "no payer wallet; pass --from-key <0xhex> or set AGENTKV_PAYER_KEY (or AGENTKV_PRIVATE_KEY)",
      );
      return EXIT.GENERIC;
    }
    // Build the payer signer at the CLI boundary so only a signer object — never the
    // raw private key — crosses into the SDK. The key itself is never printed.
    const payer = privateKeyToAccount(payerKey);

    // 4) Account-mode client (unless a test injects one). Building needs the local AES
    //    key; funding itself never encrypts, but the account-mode constructor requires it.
    let client = io.client as { fundAccount(signer: unknown, usd: number): Promise<unknown> };
    if (!io.client) {
      if (!encKey) {
        printError(
          io.stderr,
          "invalid_config",
          envAccount
            ? "account-key mode (AGENTKV_ACCOUNT_KEY) requires AGENTKV_ENCRYPTION_KEY (the local 32-byte AES key)"
            : "account.json is missing or has a malformed encryptionKey (the local 32-byte AES key)",
        );
        return EXIT.GENERIC;
      }
      client = new AgentKV({
        accountKey: acctKey,
        encryptionKey: encKey,
        endpoint: cfg.endpoint,
        network: cfg.network,
      });
    }

    // Errors from fundAccount (e.g. a server 402 payment_invalid) propagate to runCli's
    // mapError, which prints {error, code} to stderr — same as `deposit`.
    const result = await client.fundAccount(payer, usd);
    printJson(io.stdout, result);
    return EXIT.OK;
  }

  printError(
    io.stderr,
    "usage",
    "account new | account show [--reveal] | account fund <usd> [--from-key <0xhex>]",
  );
  return EXIT.USAGE;
}
