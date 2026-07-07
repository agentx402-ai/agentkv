// cli/src/awal.ts — awal-subprocess implementation of the SDK's topoffPayer hook.
//
// Pays `${endpoint}/account/deposit` with `npx awal x402 pay` (argv array via
// execFile — NEVER a shell string), authorized by the account's ak_ bearer.
// Security invariants: strict input validation before spawn, --max-amount always passed, the bearer
// never logged and REDACTED from every error (execFile errors embed the argv).
import { execFile } from "node:child_process";
import type { TopoffPayerRequest } from "@agentkv/client";

/** Pinned awal version — bump deliberately, in lockstep with the skill docs. */
export const AWAL_SPEC = "awal@2.12.0";

/** Matches the client's isAccountKeyFormat: ak_ + 64 lowercase hex. */
const AK_RE = /^ak_[0-9a-f]{64}$/;
/** Redact any bearer-shaped token from text destined for errors/logs. */
const AK_REDACT = /ak_[0-9a-f]{64}/g;
const TIMEOUT_MS = 120_000;

export type AwalExec = (
  cmd: string,
  args: string[],
  opts: { timeoutMs: number },
) => Promise<{ stdout: string }>;

const defaultExec: AwalExec = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: opts.timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve({ stdout: String(stdout) });
    });
  });

function redact(text: string): string {
  return text.replace(AK_REDACT, "ak_…");
}

/**
 * Build a topoffPayer that pays the deposit via the awal CLI. `exec` is
 * injectable for tests; production uses execFile (no shell). Resolves only
 * after awal's --json output parses and reports no error — anything less is
 * treated as unconfirmed settlement and rejected.
 */
export function awalTopoffPayer(exec: AwalExec = defaultExec) {
  return async (req: TopoffPayerRequest): Promise<void> => {
    // Validate EVERYTHING before spawn. These values come from our own SDK, but
    // the subprocess boundary is where injection would bite — fail closed.
    if (!AK_RE.test(req.accountKey)) {
      throw new Error("awal top-off: invalid account key format");
    }
    let url: URL;
    try {
      url = new URL(req.depositUrl);
    } catch {
      throw new Error("awal top-off: depositUrl is not a valid URL");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("awal top-off: depositUrl must be an http(s) URL");
    }
    // Accept both the /v1 default and the legacy unversioned path — strip an
    // optional leading /v1 segment before comparing, symmetric with the /kv/
    // guard in awalInline.ts.
    const pathname = url.pathname.replace(/^\/v1(?=\/)/, "");
    if (pathname !== "/account/deposit") {
      throw new Error("awal top-off: refusing to pay a non-deposit route");
    }
    if (!Number.isInteger(req.maxAmountAtomic) || req.maxAmountAtomic <= 0) {
      throw new Error("awal top-off: maxAmountAtomic must be a positive integer");
    }

    const args = [
      "-y",
      AWAL_SPEC,
      "x402",
      "pay",
      url.toString(),
      "-X",
      "POST",
      "-h",
      JSON.stringify({ Authorization: `Bearer ${req.accountKey}` }),
      "--max-amount",
      String(req.maxAmountAtomic),
      "--json",
    ];

    let stdout: string;
    try {
      ({ stdout } = await exec("npx", args, { timeoutMs: TIMEOUT_MS }));
    } catch (e) {
      // execFile errors embed the full argv (which contains the bearer) — redact.
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`awal payment failed: ${redact(msg)}`);
    }

    // Settlement confirmation: resolve ONLY on parseable JSON with no error field.
    // awal --json prints the result object as the last JSON document on stdout.
    let out: { error?: unknown };
    try {
      const jsonStart = stdout.indexOf("{");
      out = JSON.parse(stdout.slice(jsonStart === -1 ? stdout.length : jsonStart));
    } catch {
      throw new Error("awal top-off: could not confirm settlement (unparseable awal output)");
    }
    if (out.error) {
      throw new Error(`awal top-off failed: ${redact(String(out.error))}`);
    }
  };
}
