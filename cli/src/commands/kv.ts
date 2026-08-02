import { readFileSync } from "node:fs";
import { parseFlags } from "../args";
import { EXIT, printError, printJson, type Writer } from "../output";
import { readEnvSecret, readFileSecret, writeSecretFile } from "../secrets";

/** The validated result of parseKvArgs: either ready-to-run args, or a usage-error to report. */
export type ParsedKv =
  | { ok: true; cmd: "get"; key: string; flags: Record<string, any> }
  | { ok: true; cmd: "delete"; key: string; flags: Record<string, any> }
  | {
      ok: true;
      cmd: "set";
      key: string;
      value: unknown;
      flags: Record<string, any>;
    }
  | { ok: false; code: string; message: string; hint?: string };

/**
 * Parse and fully validate get/set/delete's own arguments — no client, no network. For `set`
 * this INCLUDES resolving the value (from --from-env / positional / --file / stdin) and parsing
 * it as JSON — the exact work runKv used to do internally. Split out so cli.ts can run this SAME
 * check before constructing the client: clientFromConfig (config.ts) mints and persists a wallet
 * on first use, so a missing key or an unresolvable/invalid value must never get that far.
 *
 * Unlike the sibling agentrag repo's parseXxxArgs (which runXxx calls again internally),
 * this is called EXACTLY ONCE per CLI invocation — by cli.ts, before the client is built — and
 * its result is threaded into runKv rather than re-derived there. set's value can be read from
 * stdin, a one-shot stream: a second call here would see EOF on the retry and wrongly reject a
 * legitimate `agentkv set key < value.json`.
 */
export function parseKvArgs(cmd: string, args: string[]): ParsedKv {
  const { flags, positionals } = parseFlags(args);
  const key = positionals[0];
  if (!key) return { ok: false, code: "usage", message: `${cmd} requires <key>` };
  if (cmd === "delete") {
    // delete reads nothing and writes nothing; reject value/secret flags that imply a
    // misunderstanding (e.g. `delete k --out backup.json` would silently drop --out and
    // destroy the value with no backup).
    const bad = (["out", "fromEnv", "file"] as const).find((f) => f in flags);
    if (bad) {
      const flag = bad === "fromEnv" ? "from-env" : bad;
      return {
        ok: false,
        code: "usage",
        message: `--${flag} is not valid for delete`,
      };
    }
    return { ok: true, cmd: "delete", key, flags };
  }
  if (cmd === "get") {
    return { ok: true, cmd: "get", key, flags };
  }
  // set — value from --from-env (raw secret string, never echoed to stdout),
  // positional arg, --file, or stdin (the last three must be valid JSON).
  let value: unknown;
  if (flags.fromEnv) {
    const r = readEnvSecret(flags.fromEnv);
    if (!r.ok) return { ok: false, code: r.code, message: r.error };
    value = r.value; // raw string secret — stored as-is, never printed
  } else {
    let raw: string;
    if (positionals[1] !== undefined) {
      raw = positionals[1];
    } else if (flags.file) {
      const r = readFileSecret(flags.file, { trim: false });
      if (!r.ok) return { ok: false, code: r.code, message: r.error };
      raw = r.value;
    } else {
      raw = readFileSync(0, "utf8"); // stdin
    }
    try {
      value = JSON.parse(raw);
    } catch {
      return {
        ok: false,
        code: "invalid_value",
        message: "value must be valid JSON",
        hint: 'examples: \'"a string"\'  42  \'{"k":"v"}\'',
      };
    }
  }
  return { ok: true, cmd: "set", key, value, flags };
}

export async function runKv(
  parsed: Extract<ParsedKv, { ok: true }>,
  io: { client: any; stdout: Writer; stderr: Writer },
): Promise<number> {
  const { key, flags } = parsed;
  if (parsed.cmd === "delete") {
    printJson(io.stdout, await io.client.delete(key));
    return EXIT.OK;
  }
  if (parsed.cmd === "get") {
    const v = await io.client.get(
      key,
      flags.idempotencyKey ? { idempotencyKey: flags.idempotencyKey } : {},
    );
    if (v === null) {
      printJson(io.stdout, flags.out ? { found: false } : null);
      return EXIT.NOT_FOUND;
    }
    // --out FILE: write the decrypted value to a local file and print only an ack
    // (path + byte count) — the secret never reaches stdout / the model context. A
    // missing/empty --out value is rejected by parseFlags, so this is never reached
    // with a falsy path (which would fall through to printing the secret).
    if (flags.out) {
      const text = typeof v === "string" ? v : JSON.stringify(v);
      let written: { path: string; bytes: number };
      try {
        written = writeSecretFile(text, flags.out);
      } catch {
        printError(
          io.stderr,
          "write_failed",
          "could not write --out file (choose a fresh path that does not already exist)",
        );
        return EXIT.USAGE;
      }
      printJson(io.stdout, {
        found: true,
        path: written.path,
        bytes: written.bytes,
      });
      return EXIT.OK;
    }
    printJson(io.stdout, v);
    return EXIT.OK;
  }
  // set
  const opts: any = {};
  if (flags.ttlDays !== undefined) opts.ttlDays = flags.ttlDays;
  if (flags.strictTtl) opts.strictTtl = true;
  if (flags.idempotencyKey) opts.idempotencyKey = flags.idempotencyKey;
  printJson(io.stdout, await io.client.set(key, parsed.value, opts));
  return EXIT.OK;
}

// list-keys — the wallet's real key names (decrypted locally); the server only ever sees
// opaque digests + ciphertext. Paginates the whole namespace by default; --limit sets the
// page size, --cursor resumes from an opaque cursor (single page when --cursor is given).
export async function runListKeys(
  args: string[],
  io: { client: any; stdout: Writer; stderr: Writer },
): Promise<number> {
  const { flags } = parseFlags(args);
  const limit = flags.limit as number | undefined;
  const onePage = flags.cursor !== undefined;
  const keys: string[] = [];
  let cursor: string | null = flags.cursor ?? null;
  do {
    const res = await io.client.listKeys(cursor ? { cursor, limit } : { limit });
    keys.push(...res.keys);
    cursor = res.cursor;
  } while (cursor && !onePage);
  printJson(io.stdout, {
    keys: keys.sort(),
    count: keys.length,
    cursor: onePage ? cursor : null,
  });
  return EXIT.OK;
}
