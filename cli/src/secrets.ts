// cli/src/secrets.ts
//
// Cross-platform helpers for storing/using a secret WITHOUT the plaintext passing
// through the model context. The read helpers (readEnvSecret / readFileSecret) are
// shared by the MCP tools and the CLI so the guards stay identical on both surfaces.
import { spawn } from "node:child_process";
import {
  closeSync,
  fchmodSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  type Stats,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath, sep } from "node:path";
import { agentkvDir } from "./keystore";

// DoS guard shared by set_from_file / get --out / CLI --file: cap the bytes read as a
// "secret" (the server enforces its own value-size limit separately).
export const MAX_SECRET_BYTES = 1024 * 1024;

// Env vars that hold key material the model must never see. Stripped from the MCP
// server's own env at startup (scrubSensitiveEnv) AND refused as a secret SOURCE, so
// an agent can't read the wallet key back into a stored value via set_from_env.
const SENSITIVE_ENV = [
  "AGENTKV_PRIVATE_KEY",
  "AGENTKV_ENCRYPTION_KEY",
  "AGENTKV_ACCOUNT_KEY",
  "AGENTKV_PAYER_KEY", // funded external-payer key (account fund / --from-key) — holds real USDC
];
// Defense in depth: any AGENTKV_ env var whose NAME looks like private/funded key material is
// ALSO protected, so a future AGENTKV_*_PRIVATE_KEY / _PAYER_KEY var is covered by default
// without a code change. Scoped to the AGENTKV_ prefix so it never refuses a user's UNRELATED
// third-party secret (storing those via set_from_env is the whole point of the tool).
const SENSITIVE_ENV_PATTERN =
  /^AGENTKV_.*(PRIVATE_KEY|PAYER_KEY|ENCRYPTION_KEY|MNEMONIC|SEED_PHRASE)$/i;

/** True if an env var name holds AgentKV's own protected key material (explicit list or pattern). */
export function isSensitiveEnvName(name: string): boolean {
  return SENSITIVE_ENV.includes(name) || SENSITIVE_ENV_PATTERN.test(name);
}

/** Delete every protected key var from `env` once the client has captured what it needs. */
export function scrubSensitiveEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const k of Object.keys(env)) {
    if (isSensitiveEnvName(k)) delete env[k];
  }
}

export type SecretRead = { ok: true; value: string } | { ok: false; error: string; code: string };

/** Read a secret from a local env var. Refuses protected key material and unset/empty. */
export function readEnvSecret(envVar: string): SecretRead {
  if (isSensitiveEnvName(envVar)) {
    return {
      ok: false,
      error: `refusing to read protected key material from ${envVar}`,
      code: "forbidden_env",
    };
  }
  const value = process.env[envVar];
  if (value === undefined || value === "") {
    return { ok: false, error: `env var ${envVar} is unset or empty`, code: "env_unset" };
  }
  return { ok: true, value };
}

/** Read a secret from a local file with path + type + size guards. */
export function readFileSecret(path: string, opts: { trim?: boolean } = {}): SecretRead {
  // Pseudo-filesystems expose process state — /proc/self/environ holds the wallet key — and
  // report unreliable sizes. Never source a "secret" from them. Check the LITERAL path FIRST,
  // before ANY filesystem access, so the guarantee holds cross-platform: on macOS/Windows there
  // is no /proc, so realpathSync would otherwise throw read_failed before we could reject it.
  const isPseudoFs = (p: string): boolean => /^(\/proc|\/sys)(\/|$)/.test(p);
  const pseudoFsRefusal: SecretRead = {
    ok: false,
    error: "refusing to read from a pseudo-filesystem path",
    code: "forbidden_path",
  };
  if (isPseudoFs(path)) return pseudoFsRefusal;
  let resolved: string;
  try {
    resolved = realpathSync(path);
  } catch {
    return { ok: false, error: "could not read file", code: "read_failed" };
  }
  // Also reject if a symlink RESOLVES into /proc or /sys (realpath defeats the redirect).
  if (isPseudoFs(resolved)) return pseudoFsRefusal;
  // Refuse the AgentKV keystore directory itself: wallet.json / account.json hold the wallet
  // private key + account bearer — the SAME material the MCP server scrubs from its env and
  // readEnvSecret refuses. Without this guard, `agentkv_set_from_file(path=~/.agentkv/wallet.json)`
  // + a get (or run_with_secret cat) exfiltrates the key into the model context, defeating the
  // env scrub. Compare the realpath'd file against the realpath'd keystore dir (honoring AGENTKV_HOME).
  const within = (child: string, parent: string): boolean =>
    child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
  const keystore = agentkvDir(process.env);
  let keystoreReal = resolvePath(keystore);
  try {
    keystoreReal = realpathSync(keystore);
  } catch {
    // keystore dir may not exist yet — the resolved (non-real) path check still applies
  }
  if (within(resolved, keystoreReal) || within(resolved, resolvePath(keystore))) {
    return {
      ok: false,
      error: "refusing to read from the AgentKV keystore directory",
      code: "forbidden_path",
    };
  }
  let st: Stats;
  try {
    st = lstatSync(resolved);
  } catch {
    return { ok: false, error: "could not read file", code: "read_failed" };
  }
  // Char devices (/dev/zero), FIFOs, etc. report size 0 and never EOF — readFileSync
  // would read forever and the size guard wouldn't catch it. Regular files only.
  if (!st.isFile()) {
    return { ok: false, error: "not a regular file", code: "not_regular_file" };
  }
  if (st.size > MAX_SECRET_BYTES) {
    return { ok: false, error: "file too large for a secret", code: "file_too_large" };
  }
  let value: string;
  try {
    value = readFileSync(resolved, "utf8");
  } catch {
    return { ok: false, error: "could not read file", code: "read_failed" };
  }
  if (opts.trim !== false) value = value.replace(/\r?\n$/, "");
  return { ok: true, value };
}

/**
 * Write a secret to a private local file; return its path + byte length (never the
 * value). With no `dest`, a fresh `agentkv-XXXX/` dir is created under os.tmpdir()
 * via mkdtemp (0700 on POSIX, user-scoped ACL on Windows).
 *
 * The file is opened O_CREAT|O_EXCL|O_WRONLY ("wx"): a pre-positioned symlink cannot
 * redirect the plaintext and an existing file is never overwritten, and the fd is
 * fchmod'd 0600 (POSIX) so there is no create->chmod TOCTOU window. NOTE: on Windows
 * an EXPLICIT `dest` inherits the parent directory's ACL (Node cannot set a
 * 0600-equivalent) — omit `dest` for a guaranteed-private file. The caller deletes it.
 */
export function writeSecretFile(value: string, dest?: string): { path: string; bytes: number } {
  const path = dest ?? join(mkdtempSync(join(tmpdir(), "agentkv-")), "value");
  const fd = openSync(path, "wx", 0o600); // O_EXCL: no symlink-follow, no overwrite
  try {
    if (process.platform !== "win32") fchmodSync(fd, 0o600); // defeat umask; no-op on Windows
    writeSync(fd, value, null, "utf8");
  } finally {
    closeSync(fd);
  }
  return { path, bytes: Buffer.byteLength(value, "utf8") };
}

// Env var names / patterns that can hijack a child process — dynamic-linker preload,
// runtime-option / startup injection, PATH and shell startup, profilers, CA-cert and
// proxy overrides. Forbidden for both the injected secret's var name and any extraEnv
// key, so a (possibly prompt-injected) agent cannot load attacker code into the child
// that holds the decrypted secret. Defense-in-depth: the agent already controls
// command/args, so a denylist need not be exhaustive — but keep it broad since it lags.
const HIJACK_ENV =
  /^(LD_|DYLD_|PYTHON|PERL5?|RUBY(OPT|LIB)|NODE_OPTIONS$|NODE_PATH$|NODE_EXTRA_CA_CERTS$|BASH_ENV$|BASH_FUNC_|ENV$|IFS$|PATH$|CDPATH$|GCONV_PATH$|LOCPATH$|NLSPATH$|MALLOC_|PROMPT_COMMAND$|PS4$|GIT_SSH|GIT_PROXY_COMMAND$|GIT_EXTERNAL_DIFF$|GIT_CONFIG|GIT_SSL_CAINFO$|GIT_SSL_NO_VERIFY$|SSL_CERT|.*CA_BUNDLE$|CLASSPATH$|_?JAVA_OPTIONS$|JDK_JAVA_OPTIONS$|JAVA_TOOL_OPTIONS$|COR(ECLR)?_PROFILER$|DOTNET_STARTUP_HOOKS$|WINEDLLOVERRIDES$|PAGER$|EDITOR$|BROWSER$|.*_PROXY$)/i;

// A valid POSIX-style env var name. Anything else (whitespace, '=', look-alikes) is
// rejected before the denylist test so malformed keys never reach spawn.
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Returns the first env var name in `keys` that is malformed or a known process-hijack
 * variable, or null if all are safe.
 */
export function forbiddenEnvKey(keys: string[]): string | null {
  return keys.find((k) => !ENV_NAME.test(k) || HIJACK_ENV.test(k)) ?? null;
}

export interface RunWithSecretResult {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

/**
 * Run `command` (argv array, no shell) with `secret` exposed as `envVar` in the
 * CHILD process environment only; return the exit code + size-capped output. stdin is
 * /dev/null (immediate EOF) so a stdin-reading command does not hang. Output is
 * accumulated as bytes and decoded once (no multibyte corruption at chunk boundaries)
 * with the cap measured in bytes. The wallet/encryption key is stripped from the child
 * env. shell:false avoids cross-shell quoting/injection — note a bare shim like `npx`
 * needs `.cmd` resolution on Windows (pass a real executable).
 *
 * Rejects if `envVar` or any `extraEnv` key is malformed or a known process-hijack
 * variable. A non-positive `timeoutMs` uses the default (a secret-holding child stays
 * bounded). A child is hard-killed (SIGKILL) at the timeout and the promise always
 * settles, so a stuck child can never hang the call.
 */
export function runWithSecret(opts: {
  secret: string;
  envVar: string;
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  extraEnv?: Record<string, string>;
  capBytes?: number;
}): Promise<RunWithSecretResult> {
  const cap = opts.capBytes ?? 64 * 1024;
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 120_000;
  return new Promise((resolve, reject) => {
    const bad = forbiddenEnvKey([opts.envVar, ...Object.keys(opts.extraEnv ?? {})]);
    if (bad) {
      reject(new Error(`refusing to set process-hijack env var: ${bad}`));
      return;
    }
    // The MCP server holds the wallet/encryption key in its own env; strip it so the
    // agent-controlled command can't read and exfiltrate it (least-privilege).
    const inherited = { ...process.env };
    for (const k of Object.keys(inherited)) {
      if (isSensitiveEnvName(k)) inherited[k] = undefined;
    }
    const child = spawn(opts.command, opts.args ?? [], {
      cwd: opts.cwd,
      env: { ...inherited, ...opts.extraEnv, [opts.envVar]: opts.secret },
      shell: false,
      timeout: timeoutMs,
      killSignal: "SIGKILL", // the built-in timeout sends a SIGTERM a child can ignore — escalate
      stdio: ["ignore", "pipe", "pipe"], // no stdin: stdin-reading commands get EOF, don't hang
    });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let settled = false;
    const finalize = (code: number | null): RunWithSecretResult => ({
      exit_code: code,
      stdout: Buffer.concat(outChunks).subarray(0, cap).toString("utf8"),
      stderr: Buffer.concat(errChunks).subarray(0, cap).toString("utf8"),
      truncated,
    });
    const done = (cb: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(hard);
      cb();
    };
    // Backstop: if neither close nor error fires shortly after the timeout, force-kill
    // and settle so the secret-holding child is reaped and the call never hangs.
    const hard = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      truncated = true;
      done(() => resolve(finalize(null)));
    }, timeoutMs + 5_000);
    child.stdout?.on("data", (d: Buffer) => {
      if (outBytes >= cap) {
        truncated = true;
        return;
      }
      outChunks.push(d);
      outBytes += d.length;
      if (outBytes > cap) truncated = true;
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (errBytes >= cap) {
        truncated = true;
        return;
      }
      errChunks.push(d);
      errBytes += d.length;
      if (errBytes > cap) truncated = true;
    });
    child.on("error", (e) => done(() => reject(e)));
    child.on("close", (code) => done(() => resolve(finalize(code))));
  });
}
