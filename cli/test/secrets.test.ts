import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  forbiddenEnvKey,
  readEnvSecret,
  readFileSecret,
  runWithSecret,
  writeSecretFile,
} from "../src/secrets";

const isPosix = process.platform !== "win32";

describe("readEnvSecret", () => {
  it("refuses to read the wallet/encryption key (forbidden_env) — closes the exfil path", () => {
    process.env.AGENTKV_PRIVATE_KEY = "0xWALLET";
    process.env.AGENTKV_ENCRYPTION_KEY = "0xENC";
    try {
      const r1 = readEnvSecret("AGENTKV_PRIVATE_KEY");
      const r2 = readEnvSecret("AGENTKV_ENCRYPTION_KEY");
      expect(r1).toEqual({ ok: false, error: expect.any(String), code: "forbidden_env" });
      expect(r2.ok).toBe(false);
      // the value never escapes, even in the error
      expect(JSON.stringify(r1)).not.toContain("0xWALLET");
    } finally {
      delete process.env.AGENTKV_PRIVATE_KEY;
      delete process.env.AGENTKV_ENCRYPTION_KEY;
    }
  });

  it("refuses to read the account-key bearer (forbidden_env) — same exfil guard", () => {
    process.env.AGENTKV_ACCOUNT_KEY = "ak_SECRETbearer";
    try {
      const r = readEnvSecret("AGENTKV_ACCOUNT_KEY");
      expect(r).toEqual({ ok: false, error: expect.any(String), code: "forbidden_env" });
      expect(JSON.stringify(r)).not.toContain("ak_SECRETbearer"); // value never escapes
    } finally {
      delete process.env.AGENTKV_ACCOUNT_KEY;
    }
  });

  it("errors env_unset for an unset/empty var, returns the value otherwise", () => {
    delete process.env.AGENTKV_T_MISSING;
    expect(readEnvSecret("AGENTKV_T_MISSING")).toMatchObject({ ok: false, code: "env_unset" });
    process.env.AGENTKV_T_OK = "the-secret";
    try {
      expect(readEnvSecret("AGENTKV_T_OK")).toEqual({ ok: true, value: "the-secret" });
    } finally {
      delete process.env.AGENTKV_T_OK;
    }
  });
});

describe("readFileSecret", () => {
  it("reads a regular file and trims a trailing newline by default", () => {
    const f = join(tmpdir(), `agentkv-rfs-${Date.now()}`);
    writeFileSync(f, "secret-value\n");
    expect(readFileSecret(f)).toEqual({ ok: true, value: "secret-value" });
    expect(readFileSecret(f, { trim: false })).toEqual({ ok: true, value: "secret-value\n" });
    rmSync(f, { force: true });
  });

  it("read_failed for a missing path", () => {
    expect(readFileSecret(join(tmpdir(), `agentkv-nope-${Date.now()}`))).toMatchObject({
      ok: false,
      code: "read_failed",
    });
  });

  it.skipIf(!isPosix)(
    "refuses /proc/self/environ (forbidden_path) — the wallet key lives there",
    () => {
      expect(readFileSecret("/proc/self/environ")).toMatchObject({
        ok: false,
        code: "forbidden_path",
      });
    },
  );

  it.skipIf(!isPosix)("refuses a non-regular file like /dev/zero (not_regular_file)", () => {
    expect(readFileSecret("/dev/zero")).toMatchObject({ ok: false, code: "not_regular_file" });
  });
});

describe("writeSecretFile", () => {
  it("writes the value to a private temp file; returns path + bytes, never the value", () => {
    const secret = "super-secret-token-🔑";
    const res = writeSecretFile(secret);
    expect(res.path).toContain("agentkv-");
    expect(res.bytes).toBe(Buffer.byteLength(secret, "utf8"));
    expect(readFileSync(res.path, "utf8")).toBe(secret);
    expect(JSON.stringify(res)).not.toContain(secret); // the return carries no secret
    rmSync(res.path, { force: true });
  });

  it("honors an explicit destination path", () => {
    const dest = join(tmpdir(), `agentkv-dest-${Date.now()}`);
    const res = writeSecretFile("x", dest);
    expect(res.path).toBe(dest);
    expect(readFileSync(dest, "utf8")).toBe("x");
    rmSync(dest, { force: true });
  });

  it("refuses to write through a pre-existing path (wx — no symlink-redirect / no clobber)", () => {
    const dest = join(tmpdir(), `agentkv-existing-${Date.now()}`);
    writeFileSync(dest, "pre-existing");
    expect(() => writeSecretFile("secret", dest)).toThrow(); // O_EXCL
    expect(readFileSync(dest, "utf8")).toBe("pre-existing"); // untouched — secret not written through it
    rmSync(dest, { force: true });
  });

  // POSIX-only: Node file-mode is a no-op on Windows (protection comes from the
  // per-user temp dir ACL), so this assertion is gated per the spec.
  it.skipIf(process.platform === "win32")("creates the file with mode 0600 on POSIX", () => {
    const res = writeSecretFile("x");
    expect(statSync(res.path).mode & 0o777).toBe(0o600);
    rmSync(res.path, { force: true });
  });
});

describe("runWithSecret", () => {
  it("injects the secret into the CHILD env only and returns its output (no secret in the return)", async () => {
    const secret = "TOPSECRET-do-not-leak";
    const res = await runWithSecret({
      secret,
      envVar: "INJECTED",
      command: process.execPath, // node — a real executable, cross-platform
      // child prints the LENGTH of the injected secret, never the secret itself
      args: ["-e", "process.stdout.write(String((process.env.INJECTED||'').length))"],
    });
    expect(res.exit_code).toBe(0);
    expect(res.stdout).toBe(String(secret.length)); // child received the full secret via env
    expect(JSON.stringify(res)).not.toContain(secret); // never in the returned shape
  });

  it("does not leak the secret into the parent process env", async () => {
    await runWithSecret({
      secret: "X",
      envVar: "EPHEMERAL_SECRET",
      command: process.execPath,
      args: ["-e", "0"],
    });
    expect(process.env.EPHEMERAL_SECRET).toBeUndefined(); // child env only
  });

  it("propagates a non-zero exit code", async () => {
    const res = await runWithSecret({
      secret: "X",
      envVar: "S",
      command: process.execPath,
      args: ["-e", "process.exit(3)"],
    });
    expect(res.exit_code).toBe(3);
  });

  it("passes extraEnv (non-secret) to the child alongside the secret", async () => {
    const res = await runWithSecret({
      secret: "S",
      envVar: "SEC",
      extraEnv: { EXTRA_FLAG: "on" },
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write((process.env.SEC==='S'?'1':'0')+(process.env.EXTRA_FLAG||''))",
      ],
    });
    expect(res.stdout).toBe("1on"); // child saw both the injected secret and the extra var
  });

  it("rejects a process-hijack env var name for the secret (LD_PRELOAD)", async () => {
    await expect(
      runWithSecret({
        secret: "x",
        envVar: "LD_PRELOAD",
        command: process.execPath,
        args: ["-e", "0"],
      }),
    ).rejects.toThrow(/process-hijack/);
  });

  it("rejects a process-hijack key in extraEnv (NODE_OPTIONS)", async () => {
    await expect(
      runWithSecret({
        secret: "x",
        envVar: "SAFE",
        extraEnv: { NODE_OPTIONS: "--require /tmp/evil.js" },
        command: process.execPath,
        args: ["-e", "0"],
      }),
    ).rejects.toThrow(/process-hijack/);
  });

  it("hard-kills a child that exceeds the timeout and never hangs", async () => {
    const start = Date.now();
    const res = await runWithSecret({
      secret: "x",
      envVar: "S",
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 60000)"], // would run for 60s
      timeoutMs: 300,
    });
    expect(Date.now() - start).toBeLessThan(10_000); // returned fast — didn't hang for 60s
    expect(res.exit_code).toBeNull(); // killed by signal
  });

  it("strips the wallet/encryption/account key from the child env (no key exfiltration via a spawned command)", async () => {
    process.env.AGENTKV_PRIVATE_KEY = "WALLETsentinel";
    process.env.AGENTKV_ENCRYPTION_KEY = "ENCsentinel";
    process.env.AGENTKV_ACCOUNT_KEY = "AKsentinel";
    try {
      const res = await runWithSecret({
        secret: "SECRETsentinel",
        envVar: "SEC",
        command: process.execPath,
        args: [
          "-e",
          "const e=process.env;process.stdout.write([e.AGENTKV_PRIVATE_KEY,e.AGENTKV_ENCRYPTION_KEY,e.AGENTKV_ACCOUNT_KEY,e.SEC].join(','))",
        ],
      });
      expect(res.stdout).not.toContain("WALLETsentinel"); // wallet key NOT inherited by the child
      expect(res.stdout).not.toContain("ENCsentinel"); // encryption key NOT inherited
      expect(res.stdout).not.toContain("AKsentinel"); // account bearer NOT inherited
      expect(res.stdout).toContain("SECRETsentinel"); // the injected secret IS present
    } finally {
      delete process.env.AGENTKV_PRIVATE_KEY;
      delete process.env.AGENTKV_ENCRYPTION_KEY;
      delete process.env.AGENTKV_ACCOUNT_KEY;
    }
  });

  it("does not hang on a stdin-reading command (stdin is /dev/null)", async () => {
    const start = Date.now();
    const res = await runWithSecret({
      secret: "s",
      envVar: "SEC",
      command: process.execPath,
      // reads stdin to EOF then exits — would block forever without stdio:["ignore",...]
      args: ["-e", "process.stdin.on('end',()=>process.exit(0)); process.stdin.resume()"],
      timeoutMs: 10_000,
    });
    expect(Date.now() - start).toBeLessThan(8_000); // EOF immediately, not a timeout kill
    expect(res.exit_code).toBe(0);
  });

  it("treats timeout_ms <= 0 as the default, not a 5s hard-kill", async () => {
    const res = await runWithSecret({
      secret: "s",
      envVar: "SEC",
      command: process.execPath,
      args: ["-e", "process.stdout.write('done')"],
      timeoutMs: 0,
    });
    expect(res.exit_code).toBe(0); // ran normally, not signal-killed
    expect(res.stdout).toBe("done");
  });

  it("decodes multibyte output without corruption", async () => {
    const res = await runWithSecret({
      secret: "s",
      envVar: "SEC",
      command: process.execPath,
      args: ["-e", "process.stdout.write('héllo-🔑-wörld')"],
    });
    expect(res.stdout).toBe("héllo-🔑-wörld");
  });
});

describe("forbiddenEnvKey", () => {
  it("flags process-hijack and malformed keys; allows benign config keys", () => {
    expect(forbiddenEnvKey(["LD_PRELOAD"])).toBe("LD_PRELOAD");
    expect(forbiddenEnvKey(["DYLD_INSERT_LIBRARIES"])).toBe("DYLD_INSERT_LIBRARIES");
    expect(forbiddenEnvKey(["PATH"])).toBe("PATH");
    expect(forbiddenEnvKey(["NODE_OPTIONS"])).toBe("NODE_OPTIONS");
    expect(forbiddenEnvKey(["NODE_EXTRA_CA_CERTS"])).toBe("NODE_EXTRA_CA_CERTS");
    expect(forbiddenEnvKey(["PYTHONPATH"])).toBe("PYTHONPATH");
    expect(forbiddenEnvKey(["HTTPS_PROXY"])).toBe("HTTPS_PROXY"); // *_PROXY redirection
    expect(forbiddenEnvKey(["REQUESTS_CA_BUNDLE"])).toBe("REQUESTS_CA_BUNDLE"); // .*CA_BUNDLE$
    expect(forbiddenEnvKey(["CURL_CA_BUNDLE"])).toBe("CURL_CA_BUNDLE");
    expect(forbiddenEnvKey(["GIT_SSL_CAINFO"])).toBe("GIT_SSL_CAINFO");
    expect(forbiddenEnvKey(["BAD KEY"])).toBe("BAD KEY"); // malformed: space
    expect(forbiddenEnvKey(["MY=KEY"])).toBe("MY=KEY"); // malformed: '='
    expect(forbiddenEnvKey(["API_KEY", "AWS_REGION", "OPENAI_API_KEY"])).toBeNull();
  });
});
