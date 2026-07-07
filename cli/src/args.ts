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

export function parseFlags(args: string[]): { flags: Record<string, any>; positionals: string[] } {
  const flags: Record<string, any> = {};
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const boolish = ["strict-ttl", "pretty", "json", "reveal"].includes(key);
      const val = boolish ? true : args[++i];
      // A value-expecting flag MUST get a real value. Missing (`--out` at end),
      // empty (`--out ""`), or flag-like (`--out --pretty`) values would otherwise be
      // silently swallowed — e.g. `get --out` falling through to printing the secret
      // to stdout. Fail loud instead (caught by runCli's mapError).
      if (!boolish && (val === undefined || val === "" || (val as string).startsWith("--"))) {
        throw new UsageError(`flag --${key} requires a value`);
      }
      if (key.endsWith("usd") || key === "ttl-days") {
        // Numeric flags MUST be a finite, non-negative number — mirror the env path's
        // fail-CLOSED behavior (config.ts numOrThrow). Otherwise a typo like
        // `--max-spend-usd 0,05` -> NaN is non-nullish, so it wins over a valid env cap
        // AND `usd > NaN` is always false, silently DISABLING the spend cap on real funds
        // (and `--ttl-days abc` -> NaN serializes as ttl_days:null, dropping retention).
        const n = Number(val);
        if (!Number.isFinite(n) || n < 0) {
          throw new UsageError(
            `flag --${key} must be a non-negative number (got ${JSON.stringify(val)})`,
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
