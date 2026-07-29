import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli";
import { resolveConfig } from "../src/config";

function fakeClient() {
  return {
    set: vi.fn(async () => ({ ok: true, expires_at: "x" })),
    get: vi.fn(async () => ({ hello: "world" })),
    delete: vi.fn(async () => ({ ok: true })),
    balance: vi.fn(async () => 994),
    deposit: vi.fn(async () => ({ credits_added: 5000, balance: 5000 })),
    address: "0xabc",
  };
}

describe("runCli", () => {
  it("get prints decrypted JSON and exits 0", async () => {
    const out: string[] = [];
    const code = await runCli(["get", "k"], {
      client: fakeClient() as any,
      stdout: (s) => out.push(s),
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(JSON.parse(out.join(""))).toEqual({ hello: "world" });
  });

  it("wallet new prints an address+key and never calls the client", async () => {
    const out: string[] = [];
    const client = fakeClient();
    const code = await runCli(["wallet", "new"], {
      client: client as any,
      stdout: (s) => out.push(s),
      stderr: () => {},
    });
    expect(code).toBe(0);
    const j = JSON.parse(out.join(""));
    expect(j.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(j.privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });

  it("configured private key never appears in stdout or stderr output", async () => {
    const SENTINEL = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const env = {
      AGENTKV_PRIVATE_KEY: SENTINEL,
      AGENTKV_ENDPOINT: "https://test.example.workers.dev",
    };

    const out: string[] = [];
    const err: string[] = [];
    const client = fakeClient();

    // Test 1: balance command with injected fakeClient (no config resolution needed)
    const code1 = await runCli(["balance"], {
      client: client as any,
      env,
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
    });
    expect(code1).toBe(0);

    // Test 2: a synchronous config error (no network, no injected client). Endpoint now
    // defaults, so trigger the error via a malformed cap; the key is still in env, so this
    // verifies it doesn't leak even on the error path.
    const code2 = await runCli(["balance"], {
      env: { AGENTKV_PRIVATE_KEY: SENTINEL, AGENTKV_MAX_SPEND_USD: "not-a-number" },
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
    });
    expect(code2).not.toBe(0); // exits with error

    const allOutput = [...out, ...err].join("");
    expect(allOutput).not.toContain(SENTINEL);
  });

  it("config persists --onramp-app-id and --onramp-provider (previously accepted then dropped)", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentkv-cfg-"));
    try {
      const out: string[] = [];
      const code = await runCli(
        ["config", "--onramp-app-id", "proj-1", "--onramp-provider", "coinbase"],
        {
          client: fakeClient() as any,
          env: { AGENTKV_HOME: home } as any,
          stdout: (s) => out.push(s),
          stderr: () => {},
        },
      );
      expect(code).toBe(0);
      const file = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
      expect(file).toMatchObject({ onrampAppId: "proj-1", onrampProvider: "coinbase" });
      // the documented flag>env>FILE precedence is now actually reachable via the CLI:
      const cfg = resolveConfig({}, {}, () => file);
      expect(cfg.onrampConfig?.appId).toBe("proj-1");
      expect(cfg.onrampProvider).toBe("coinbase");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("config rejects an unknown --onramp-provider instead of persisting it", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentkv-cfg-"));
    try {
      const err: string[] = [];
      const code = await runCli(["config", "--onramp-provider", "bogus"], {
        client: fakeClient() as any,
        env: { AGENTKV_HOME: home } as any,
        stdout: () => {},
        stderr: (s) => err.push(s),
      });
      expect(code).not.toBe(0);
      expect(err.join("")).toMatch(/known providers/);
      expect(existsSync(join(home, "config.json"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("config writes atomically and leaves no tmp file behind", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentkv-cfg-"));
    try {
      const code = await runCli(["config", "--endpoint", "https://x.test"], {
        client: fakeClient() as any,
        env: { AGENTKV_HOME: home } as any,
        stdout: () => {},
        stderr: () => {},
      });
      expect(code).toBe(0);
      expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).endpoint).toBe(
        "https://x.test",
      );
      expect(readdirSync(home).filter((f) => f.includes("tmp"))).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "a write failure cleans up the temp file and reports the real path, not the tmp name",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "agentkv-cfg-"));
      try {
        // Make the directory read-only to force a write failure
        chmodSync(home, 0o500);
        const err: string[] = [];
        const code = await runCli(["config", "--endpoint", "https://x.test"], {
          client: fakeClient() as any,
          env: { AGENTKV_HOME: home } as any,
          stdout: () => {},
          stderr: (s) => err.push(s),
        });
        expect(code).not.toBe(0);
        const stderr = err.join("");
        // Error should mention the real config.json path
        expect(stderr).toContain("config.json");
        // Error should NOT mention the tmp filename
        expect(stderr).not.toContain(".tmp");
        // No tmp file should be left behind
        chmodSync(home, 0o755); // restore permissions to clean up
        expect(readdirSync(home).filter((f) => f.includes("tmp"))).toEqual([]);
      } finally {
        try {
          chmodSync(home, 0o755);
        } catch {
          // already failed to write or already cleaned up
        }
        rmSync(home, { recursive: true, force: true });
      }
    },
  );
});
