// cli/src/awalInline.ts — awal-subprocess implementation of the SDK's opInlinePayer hook.
//
// Routes a WHOLE account-key set()/get() op through `awal x402 pay -X <method> ...
// <url>` (argv array via execFile — NEVER a shell string): awal drives its OWN
// 402->pay->retry against the backend and this hook hands the SDK back the final
// response for it to parse/decrypt as usual (see client/src/index.ts account-key
// set()/get() inline branches).
//
// Security invariants mirror cli/src/awal.ts: strict input validation BEFORE spawn
// (the subprocess boundary is where injection would bite), the bearer never
// logged and REDACTED from every error (execFile errors embed the full argv),
// fixed 120s timeout, windowsHide.
import { execFile } from "node:child_process";
import type { OpInlineRequest, OpInlineResponse } from "@agentkv/client";
import { AWAL_SPEC } from "./awal";

/** Matches a well-formed `Authorization: Bearer ak_<64 lowercase hex>` header value. */
const BEARER_RE = /^Bearer ak_[0-9a-f]{64}$/;
/** Redact any bearer-shaped token from text destined for errors/logs. */
const AK_REDACT = /ak_[0-9a-f]{64}/g;
const TIMEOUT_MS = 120_000;

export type AwalInlineExec = (
  cmd: string,
  args: string[],
  opts: { timeoutMs: number },
) => Promise<{ stdout: string }>;

const defaultExec: AwalInlineExec = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: opts.timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve({ stdout: String(stdout) });
    });
  });

function redact(text: string): string {
  return text.replace(AK_REDACT, "ak_…");
}

/** awal's `--json` shape for a settled (2xx) paid response — `data` is ALREADY parsed JSON. */
interface AwalJsonSuccess {
  status: number;
  statusText?: string;
  data: unknown;
  headers?: Record<string, string>;
}

/** awal's `--json` shape for any non-2xx / network / balance failure — collapses status away. */
interface AwalJsonFailure {
  success: false;
  error: { code?: string; message?: string };
}

/**
 * Build an opInlinePayer that routes a whole account-key op through `awal x402 pay`.
 * `exec` is injectable for tests; production uses execFile (no shell). Resolves ONLY
 * with a confirmed settled response — anything else (a parse failure, an awal-reported
 * error, a subprocess error) throws, per the SDK's opInlinePayer contract.
 *
 * KNOWN LIMITATION: awal's `--json` output collapses EVERY non-2xx response (payment
 * failure, network error, and a genuine 404 from the worker) into the same
 * `{success:false, error}` shape — there is no way to distinguish "key not found" from
 * "payment failed" through this transport. So a get() on a missing key routed through
 * this hook surfaces as a THROWN error, not the `status:404` -> `null` the SDK's inline
 * branch otherwise supports (client/src/index.ts). This is an accepted trade-off of
 * using awal (a general-purpose x402 client) as the transport rather than a bespoke one.
 */
export function awalInlinePayer(exec: AwalInlineExec = defaultExec) {
  return async (req: OpInlineRequest): Promise<OpInlineResponse> => {
    // Validate EVERYTHING before spawn. These values come from our own SDK, but the
    // subprocess boundary is where injection would bite — fail closed.
    const bearer = req.headers.Authorization;
    if (typeof bearer !== "string" || !BEARER_RE.test(bearer)) {
      throw new Error("awal inline pay: missing or malformed Authorization bearer");
    }
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      throw new Error("awal inline pay: url is not a valid URL");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("awal inline pay: url must be an http(s) URL");
    }
    // Accept both the /v1 default and the legacy unversioned path — strip an
    // optional leading /v1 segment before checking, so a genuine non-kv route
    // (e.g. /v1/account/deposit) still throws.
    const pathname = url.pathname.replace(/^\/v1(?=\/)/, "");
    if (!pathname.startsWith("/kv/")) {
      throw new Error("awal inline pay: refusing to pay a non-/kv/ route");
    }
    if (!Number.isInteger(req.maxAmountAtomic) || req.maxAmountAtomic <= 0) {
      throw new Error("awal inline pay: maxAmountAtomic must be a positive integer");
    }
    if (req.method !== "POST" && req.method !== "GET") {
      throw new Error("awal inline pay: method must be POST or GET");
    }

    const args = [
      "-y",
      AWAL_SPEC,
      "x402",
      "pay",
      url.toString(),
      "-X",
      req.method,
      ...(req.method === "POST" && req.body != null ? ["-d", req.body] : []),
      "-h",
      JSON.stringify(req.headers),
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
      throw new Error(`awal inline pay failed: ${redact(msg)}`);
    }

    // awal prints its result object as the last JSON document on stdout.
    let parsed: unknown;
    try {
      const jsonStart = stdout.indexOf("{");
      parsed = JSON.parse(stdout.slice(jsonStart === -1 ? stdout.length : jsonStart));
    } catch {
      throw new Error("awal inline pay: could not parse awal --json output");
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("awal inline pay: could not parse awal --json output");
    }

    // FAILURE shape: any non-2xx (payment failure, insufficient balance, network error,
    // or a worker 404 — awal gives us no way to tell these apart, see KNOWN LIMITATION).
    if ("success" in parsed && (parsed as AwalJsonFailure).success === false) {
      const failure = parsed as AwalJsonFailure;
      const message = failure.error?.message ?? failure.error?.code ?? "unknown awal error";
      throw new Error(`awal inline pay failed: ${redact(message)}`);
    }
    if ("error" in parsed && (parsed as { error?: unknown }).error) {
      throw new Error(
        `awal inline pay failed: ${redact(String((parsed as { error: unknown }).error))}`,
      );
    }

    // SUCCESS shape.
    const ok = parsed as AwalJsonSuccess;
    if (typeof ok.status !== "number") {
      throw new Error("awal inline pay: unrecognized awal --json output (missing status)");
    }
    return {
      status: ok.status,
      // Re-stringify: awal already parses the body as JSON, but the SDK does its own
      // JSON.parse(body) on whatever this hook returns.
      body: JSON.stringify(ok.data ?? null),
      headers: ok.headers ?? {},
    };
  };
}
