/**
 * A user/argument error (missing flag value, malformed numeric flag). Distinct from a
 * runtime failure so runCli's mapError can return EXIT.USAGE (2), not the generic EXIT (1) —
 * scripts branch on that code.
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

// Every long flag the CLI accepts, across all commands. An unknown flag is rejected
// (fail-closed) rather than silently swallowed — a typo like `--max-spend-us 5` must not
// slip through as a no-op and leave a spend cap unset on real funds.
const KNOWN_FLAGS = new Set([
  "endpoint",
  "network",
  "max-spend-usd",
  "ttl-days",
  "strict-ttl",
  "pretty",
  "json",
  "reveal",
  "out",
  "file",
  "from-env",
  "cursor",
  "limit",
  "idempotency-key",
  "onramp-app-id",
  "onramp-provider",
]);

// Flags that once existed and were REMOVED, mapped to the migration to print instead.
// Checked BEFORE the KNOWN_FLAGS test so a removed flag fails with the replacement rather
// than a bare `unknown flag --from-key`, which reads like a typo and leaves an operator
// with a working script guessing at what to do. The message is a fixed string and the
// flag's VALUE is never read or echoed — `--from-key`'s value WAS a wallet private key.
const REMOVED_FLAGS = new Map([
  [
    "from-key",
    "--from-key was removed: a private key passed as an argument is readable by other " +
      "processes (`ps`, /proc/<pid>/cmdline) and is written to shell history. Provide the payer " +
      "key as AGENTKV_PAYER_KEY in the environment instead — via `export` from a shell profile " +
      "or a secret-manager wrapper, NOT an inline `AGENTKV_PAYER_KEY=0x… agentkv …` prefix, " +
      "which shell history records just the same. With none set, the local wallet keystore is used.",
  ],
]);

export function parseFlags(args: string[]): {
  flags: Record<string, any>;
  positionals: string[];
} {
  const flags: Record<string, any> = {};
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const removed = REMOVED_FLAGS.get(key);
      if (removed) {
        throw new UsageError(removed);
      }
      if (!KNOWN_FLAGS.has(key)) {
        throw new UsageError(`unknown flag --${key}`);
      }
      const boolish = ["strict-ttl", "pretty", "json", "reveal"].includes(key);
      const val = boolish ? true : args[++i];
      // A value-expecting flag MUST get a real value. Missing (`--out` at end),
      // empty (`--out ""`), or flag-like (`--out --pretty`) values would otherwise be
      // silently swallowed — e.g. `get --out` falling through to printing the secret
      // to stdout. Fail loud instead (caught by runCli's mapError).
      if (!boolish && (val === undefined || val === "" || (val as string).startsWith("--"))) {
        throw new UsageError(`flag --${key} requires a value`);
      }
      if (key.endsWith("usd") || key === "ttl-days" || key === "limit") {
        // Numeric flags MUST be a finite, non-negative number — mirror the env path's
        // fail-CLOSED behavior (config.ts numOrThrow). Otherwise a typo like
        // `--max-spend-usd 0,05` -> NaN is non-nullish, so it wins over a valid env cap
        // AND `usd > NaN` is always false, silently DISABLING the spend cap on real funds
        // (and `--ttl-days abc` -> NaN serializes as ttl_days:null, dropping retention;
        // `--limit abc` -> NaN reaches the wire as limit=NaN).
        const n = Number(val);
        if (!Number.isFinite(n) || n < 0) {
          throw new UsageError(
            `flag --${key} must be a non-negative number (got ${JSON.stringify(val)})`,
          );
        }
        if (key === "limit" && (!Number.isInteger(n) || n < 1)) {
          throw new UsageError(
            `flag --limit must be a positive integer (got ${JSON.stringify(val)})`,
          );
        }
        flags[camel(key)] = n;
      } else {
        flags[camel(key)] = val;
      }
    } else positionals.push(a);
  }
  return { flags, positionals };
}

export const camel = (s: string) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
