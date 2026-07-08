/**
 * Tests for:
 *   - runWallet (cli/src/commands/wallet.ts) — all branches
 *   - runCli dispatch (cli/src/cli.ts) — unknown-command + mapError
 *
 * mapError reachability: cli.ts awaits runKv/runCredits, so async rejections from
 * a paid sub-command (get/set/deposit throwing SpendCapError/AgentKVError) are
 * caught by runCli's try/catch and mapped to the right exit code. Synchronous
 * throws from config resolution (clientFromConfig / resolveConfig) reach it too.
 */

import { AgentKVError, SpendCapError } from "@agentkv/client";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    stdout: (s: string) => out.push(s),
    stderr: (s: string) => err.push(s),
    outJson: () => JSON.parse(out.join("")),
    errJson: () => JSON.parse(err.join("")),
    out,
    err,
  };
}

function fakeClient(overrides: Record<string, any> = {}) {
  return {
    set: vi.fn(async () => ({ ok: true, expires_at: "x" })),
    get: vi.fn(async () => ({ hello: "world" })),
    delete: vi.fn(async () => ({ ok: true })),
    balance: vi.fn(async () => 999),
    deposit: vi.fn(async () => ({ credits_added: 5000, balance: 5000 })),
    address: "0xabc",
    ...overrides,
  };
}

// ─── wallet subcommand ────────────────────────────────────────────────────────

describe("wallet new", () => {
  it("exits 0 and prints a valid address + privateKey + note", async () => {
    const io = makeIo();
    const code = await runCli(["wallet", "new"], {
      client: fakeClient() as any,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(0); // EXIT.OK
    const j = io.outJson();
    expect(j.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(j.privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(typeof j.note).toBe("string");
    expect(j.note.length).toBeGreaterThan(0);
  });

  it("never calls the injected client", async () => {
    const client = fakeClient();
    await runCli(["wallet", "new"], {
      client: client as any,
      stdout: () => {},
      stderr: () => {},
    });
    expect(client.set).not.toHaveBeenCalled();
    expect(client.get).not.toHaveBeenCalled();
    expect(client.delete).not.toHaveBeenCalled();
    expect(client.balance).not.toHaveBeenCalled();
    expect(client.deposit).not.toHaveBeenCalled();
  });

  it("generates a fresh keypair each call", async () => {
    const keys: string[] = [];
    for (let i = 0; i < 3; i++) {
      const out: string[] = [];
      await runCli(["wallet", "new"], { stdout: (s) => out.push(s), stderr: () => {} });
      keys.push(JSON.parse(out.join("")).privateKey);
    }
    expect(new Set(keys).size).toBe(3);
  });

  it("nothing is written to stderr on success", async () => {
    const io = makeIo();
    await runCli(["wallet", "new"], {
      client: fakeClient() as any,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(io.err).toHaveLength(0);
  });
});

describe("wallet with no/bad subcommand", () => {
  it("'wallet' alone → EXIT.USAGE + stderr code 'usage'", async () => {
    const io = makeIo();
    const code = await runCli(["wallet"], {
      client: fakeClient() as any,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(2); // EXIT.USAGE
    const e = io.errJson();
    expect(e.code).toBe("usage");
    expect(io.out).toHaveLength(0);
  });

  it("'wallet bogus' → EXIT.USAGE + stderr code 'usage'", async () => {
    const io = makeIo();
    const code = await runCli(["wallet", "bogus"], {
      client: fakeClient() as any,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(2); // EXIT.USAGE
    expect(io.errJson().code).toBe("usage");
  });

  it("'wallet show' with no wallet → OK + address null", async () => {
    const io = makeIo();
    const code = await runCli(["wallet", "show"], {
      env: { AGENTKV_HOME: "/tmp/agentkv-test-no-such-dir-9f3a2" },
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(0); // EXIT.OK — show is a valid subcommand now
    expect(io.outJson().address).toBeNull();
  });

  it("'wallet new extra-arg' still succeeds (extra positionals are ignored)", async () => {
    const io = makeIo();
    const code = await runCli(["wallet", "new", "ignored"], {
      client: fakeClient() as any,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    // runWallet only checks args[0] === "new"; extra args are ignored
    expect(code).toBe(0);
    expect(io.outJson().address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});

// ─── runCli dispatch — unknown command ───────────────────────────────────────

describe("runCli unknown command", () => {
  it("'bogus' → EXIT.USAGE + stderr hints at available commands", async () => {
    const io = makeIo();
    const code = await runCli(["bogus"], {
      client: fakeClient() as any,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(2); // EXIT.USAGE
    const e = io.errJson();
    expect(e.code).toBe("usage");
    expect(e.hint).toMatch(/commands:/);
    expect(e.hint).toMatch(/wallet/);
    expect(e.hint).toMatch(/set/);
  });

  it("empty argv → EXIT.OK + prints help to stdout", async () => {
    const out: string[] = [];
    const code = await runCli([], {
      client: fakeClient() as any,
      stdout: (s) => out.push(s),
      stderr: () => {},
    });
    expect(code).toBe(0); // EXIT.OK — bare `agentkv` shows usage, doesn't error
    expect(out.join("")).toMatch(/Usage: agentkv/);
  });

  it("--version → EXIT.OK + a semver on stdout", async () => {
    const out: string[] = [];
    const code = await runCli(["--version"], { stdout: (s) => out.push(s), stderr: () => {} });
    expect(code).toBe(0);
    expect(out.join("").trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("rejects an unknown flag with EXIT.USAGE (fail-closed, not silently swallowed)", async () => {
    const io = makeIo();
    const code = await runCli(["set", "k", "{}", "--bogus", "x"], {
      client: fakeClient() as any,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(2); // EXIT.USAGE
    expect(io.errJson().error).toMatch(/unknown flag/);
  });

  it("unknown command writes nothing to stdout", async () => {
    const io = makeIo();
    await runCli(["definitely-not-a-command"], {
      client: fakeClient() as any,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(io.out).toHaveLength(0);
  });
});

// ─── runCli mapError — synchronous throw paths ───────────────────────────────
//
// mapError is reached BOTH by synchronous throws (clientFromConfig()/resolveConfig()
// failing before dispatch, or a UsageError from parseFlags) AND by awaited sub-command
// rejections: cli.ts uses `return await runKv(...)` / `return await runCredits(...)`, so a
// rejection from a paid command is caught by runCli's try/catch and mapped to an exit code
// (see the async-rejection tests below). These tests cover the synchronous path.

describe("runCli mapError — synchronous throws reach mapError", () => {
  it("malformed AGENTKV_MAX_SPEND_USD → plain Error → EXIT.GENERIC (1)", async () => {
    const io = makeIo();
    // resolveConfig throws synchronously on a malformed cap (fail-closed). A private key
    // is supplied so this path never touches the wallet keystore (no key = auto-provision).
    const code = await runCli(["get", "k"], {
      env: {
        AGENTKV_ENDPOINT: "https://test.example.workers.dev",
        AGENTKV_PRIVATE_KEY: `0x${"a".repeat(64)}`,
        AGENTKV_MAX_SPEND_USD: "abc",
      },
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(1); // EXIT.GENERIC
    const e = io.errJson();
    expect(e.code).toBe("error");
    expect(e.error).toMatch(/AGENTKV_MAX_SPEND_USD/);
  });
});

// ─── mapError maps async sub-command rejections to exit codes ────────────────
//
// cli.ts awaits runKv/runCredits, so a rejection thrown inside a paid command
// (e.g. client.get throwing) is caught by runCli's try/catch and mapped — the
// CLI exits with the right code and a clean JSON error, never an unhandled reject.

describe("runCli mapError — async sub-command rejections map to exit codes", () => {
  it("SpendCapError from get() → EXIT.PAYMENT (3), code 'spend_cap_exceeded'", async () => {
    const client = fakeClient({
      get: vi.fn(async () => {
        throw new SpendCapError("cap exceeded");
      }),
    });
    const io = makeIo();
    const code = await runCli(["get", "k"], {
      client: client as any,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(3); // EXIT.PAYMENT
    expect(io.errJson().code).toBe("spend_cap_exceeded");
    expect(io.out).toHaveLength(0);
  });

  it("AgentKVError(404) from get() → EXIT.NOT_FOUND (4), code 'not_found'", async () => {
    const client = fakeClient({
      get: vi.fn(async () => {
        throw new AgentKVError("not found", "not_found", 404);
      }),
    });
    const io = makeIo();
    const code = await runCli(["get", "k"], {
      client: client as any,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(4); // EXIT.NOT_FOUND
    expect(io.errJson().code).toBe("not_found");
  });

  it("AgentKVError(402) from deposit() → EXIT.PAYMENT (3) (out-of-funds is a payment failure)", async () => {
    const client = fakeClient({
      deposit: vi.fn(async () => {
        throw new AgentKVError("payment required", "payment_required", 402);
      }),
    });
    const io = makeIo();
    const code = await runCli(["deposit", "5"], {
      client: client as any,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(3); // EXIT.PAYMENT — a real 402 maps to the payment exit code, not generic
    expect(io.errJson().code).toBe("payment_required");
  });

  it("plain Error from set() → EXIT.GENERIC (1), code 'error'", async () => {
    const client = fakeClient({
      set: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const io = makeIo();
    const code = await runCli(["set", "k", "1"], {
      client: client as any,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(1); // EXIT.GENERIC
    const e = io.errJson();
    expect(e.code).toBe("error");
    expect(e.error).toBe("boom");
  });

  it("thrown non-Error string from get() → EXIT.GENERIC (1), error = String(e)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-throw-literal
    const client = fakeClient({
      get: vi.fn(async () => {
        throw "raw string error";
      }),
    });
    const io = makeIo();
    const code = await runCli(["get", "k"], {
      client: client as any,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(1); // EXIT.GENERIC
    expect(io.errJson().error).toBe("raw string error");
  });
});
