import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentKVError, SpendCapError } from "@agentkv/client";
import { parseFlags, UsageError } from "./args";
import { runAccount } from "./commands/account";
import { runCredits } from "./commands/credits";
import { runFund } from "./commands/fund";
import { runKv, runListKeys } from "./commands/kv";
import { runWallet } from "./commands/wallet";
import { clientFromConfig, readConfigFile, resolveConfig } from "./config";
import { agentkvDir } from "./keystore";
import { EXIT, printError, printJson, type Writer } from "./output";

export interface Deps {
  client?: any;
  stdout?: Writer;
  stderr?: Writer;
  env?: NodeJS.ProcessEnv;
}

export { parseFlags } from "./args";

export async function runCli(argv: string[], deps: Deps = {}): Promise<number> {
  const stdout = deps.stdout ?? ((s) => process.stdout.write(s));
  const stderr = deps.stderr ?? ((s) => process.stderr.write(s));
  const [cmd, ...rest] = argv;
  try {
    const env = deps.env ?? process.env;
    if (cmd === "wallet") return runWallet(rest, { stdout, stderr, env });
    // `fund` builds a card→USDC onramp URL — purely local (no client/network needed).
    if (cmd === "fund") return runFund(rest, { stdout, stderr, env });
    if (cmd === "config") return runConfig(rest, { stdout, stderr, env });
    if (cmd === "account") {
      // `account new` is purely local (never builds a client). `account show` builds its
      // OWN account-mode client internally (from the env var OR the account file), so it
      // always reports the ACCOUNT's balance — never a wallet's, and never missing when
      // the account is env-only. Do NOT build one via clientFromConfig here: with
      // AGENTKV_PRIVATE_KEY set it can hand back a WALLET-mode client (wrong namespace).
      // Only an explicitly injected client (tests) is passed through.
      return await runAccount(rest, { client: deps.client, stdout, stderr, env });
    }
    if (cmd === "mcp") {
      // Handle mcp BEFORE building a client — startMcp builds its own (with the stderr
      // notify). Building one here would do the config/keystore work twice and discard it.
      const { startMcp } = await import("./mcp.js");
      await startMcp({ env: deps.env, client: deps.client });
      return EXIT.OK;
    }
    // Only these commands need a client. Dispatch on cmd FIRST so an unknown/typo'd command
    // returns the usage error WITHOUT constructing a client (which would auto-mint + persist
    // a wallet.json as a side effect and could mask the usage error with a keystore error).
    const KV_COMMANDS = new Set(["set", "get", "delete", "list-keys", "balance", "deposit"]);
    if (!KV_COMMANDS.has(cmd)) {
      printError(
        stderr,
        "usage",
        `unknown command: ${cmd ?? "(none)"}`,
        "commands: set get delete list-keys deposit balance wallet account fund config mcp",
      );
      return EXIT.USAGE;
    }
    const client =
      deps.client ??
      clientFromConfig(
        resolveConfig(parseFlags(rest).flags, env, () => readConfigFile(env)),
        {
          env,
          // Auto-provision notice -> stderr, so it never pollutes JSON stdout.
          notify: (m) => stderr(`agentkv: ${m}\n`),
        },
      );
    if (cmd === "set" || cmd === "get" || cmd === "delete")
      return await runKv(cmd, rest, { client, stdout, stderr });
    if (cmd === "list-keys") return await runListKeys(rest, { client, stdout, stderr });
    // balance | deposit
    return await runCredits(cmd, rest, { client, stdout, stderr });
  } catch (e) {
    return mapError(e, stderr);
  }
}

function mapError(e: unknown, stderr: Writer): number {
  if (e instanceof SpendCapError) {
    printError(stderr, e.code, e.message);
    return EXIT.PAYMENT;
  }
  if (e instanceof AgentKVError) {
    printError(stderr, e.code, e.message);
    return e.status === 404 ? EXIT.NOT_FOUND : EXIT.GENERIC;
  }
  // A usage/argument error (bad flag) is a distinct exit code from a runtime failure.
  if (e instanceof UsageError) {
    printError(stderr, "usage", e.message);
    return EXIT.USAGE;
  }
  printError(stderr, "error", e instanceof Error ? e.message : String(e));
  return EXIT.GENERIC;
}

function runConfig(
  args: string[],
  io: { stdout: Writer; stderr: Writer; env?: NodeJS.ProcessEnv },
): number {
  const env = io.env ?? process.env;
  const { flags } = parseFlags(args); // numeric flags already validated (fail-closed) here
  // Resolve via agentkvDir so AGENTKV_HOME is honored (config.json is a sibling of
  // wallet.json/account.json). Read-merge-write: overlay ONLY the provided flags onto the
  // existing file, so `config --endpoint X` then `config --max-spend-usd 5` doesn't wipe the
  // endpoint (and a no-flag `config` doesn't truncate the file to {}).
  const dir = agentkvDir(env);
  mkdirSync(dir, { recursive: true });
  const existing = (readConfigFile(env) as Record<string, unknown> | null) ?? {};
  const merged: Record<string, unknown> = { ...existing };
  if (flags.endpoint) merged.endpoint = flags.endpoint;
  if (flags.network) merged.network = flags.network;
  if (flags.maxSpendUsd !== undefined) merged.maxSpendUsd = flags.maxSpendUsd;
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(merged, null, 2));
  printJson(io.stdout, { ok: true, path, ...merged });
  return EXIT.OK;
}

// CLI entry point when run as a binary. Detect main-module execution ROBUSTLY: npm installs
// the bin as a POSIX SYMLINK named `agentkv` -> dist/cli.js, and Node does NOT realpath
// process.argv[1] through it — so an `endsWith("cli.js")` guard is false for every installed
// invocation (`npx @agentkv/cli …`, a globally-installed `agentkv …`), silently exiting 0
// without running any command. Compare the realpath'd argv[1] to this module's own path.
function isMainModule(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}
if (isMainModule()) {
  runCli(process.argv.slice(2)).then((code) => process.exit(code));
}
