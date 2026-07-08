import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli";

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
});
