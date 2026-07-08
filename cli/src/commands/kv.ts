import { readFileSync } from "node:fs";
import { parseFlags } from "../args";
import { EXIT, printError, printJson, type Writer } from "../output";
import { readEnvSecret, readFileSecret, writeSecretFile } from "../secrets";

export async function runKv(
  cmd: string,
  args: string[],
  io: { client: any; stdout: Writer; stderr: Writer },
): Promise<number> {
  const { flags, positionals } = parseFlags(args);
  const key = positionals[0];
  if (!key) {
    printError(io.stderr, "usage", `${cmd} requires <key>`);
    return EXIT.USAGE;
  }
  if (cmd === "delete") {
    // delete reads nothing and writes nothing; reject value/secret flags that imply a
    // misunderstanding (e.g. `delete k --out backup.json` would silently drop --out and
    // destroy the value with no backup).
    const bad = (["out", "fromEnv", "file"] as const).find((f) => f in flags);
    if (bad) {
      const flag = bad === "fromEnv" ? "from-env" : bad;
      printError(io.stderr, "usage", `--${flag} is not valid for delete`);
      return EXIT.USAGE;
    }
    printJson(io.stdout, await io.client.delete(key));
    return EXIT.OK;
  }
  if (cmd === "get") {
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
      printJson(io.stdout, { found: true, path: written.path, bytes: written.bytes });
      return EXIT.OK;
    }
    printJson(io.stdout, v);
    return EXIT.OK;
  }
  // set — value from --from-env (raw secret string, never echoed to stdout),
  // positional arg, --file, or stdin (the last three must be valid JSON).
  let value: unknown;
  if (flags.fromEnv) {
    const r = readEnvSecret(flags.fromEnv);
    if (!r.ok) {
      printError(io.stderr, r.code, r.error);
      return EXIT.USAGE;
    }
    value = r.value; // raw string secret — stored as-is, never printed
  } else {
    let raw: string;
    if (positionals[1] !== undefined) {
      raw = positionals[1];
    } else if (flags.file) {
      const r = readFileSecret(flags.file, { trim: false });
      if (!r.ok) {
        printError(io.stderr, r.code, r.error);
        return EXIT.USAGE;
      }
      raw = r.value;
    } else {
      raw = readFileSync(0, "utf8"); // stdin
    }
    try {
      value = JSON.parse(raw);
    } catch {
      printError(
        io.stderr,
        "invalid_value",
        "value must be valid JSON",
        'examples: \'"a string"\'  42  \'{"k":"v"}\'',
      );
      return EXIT.USAGE;
    }
  }
  const opts: any = {};
  if (flags.ttlDays !== undefined) opts.ttlDays = flags.ttlDays;
  if (flags.strictTtl) opts.strictTtl = true;
  if (flags.idempotencyKey) opts.idempotencyKey = flags.idempotencyKey;
  printJson(io.stdout, await io.client.set(key, value, opts));
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
  const limit = flags.limit !== undefined ? Number(flags.limit) : undefined;
  const onePage = flags.cursor !== undefined;
  const keys: string[] = [];
  let cursor: string | null = flags.cursor ?? null;
  do {
    const res = await io.client.listKeys(cursor ? { cursor, limit } : { limit });
    keys.push(...res.keys);
    cursor = res.cursor;
  } while (cursor && !onePage);
  printJson(io.stdout, { keys: keys.sort(), count: keys.length, cursor: onePage ? cursor : null });
  return EXIT.OK;
}
