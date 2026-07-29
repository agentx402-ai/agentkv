/**
 * Lifecycle test for `agentkv mcp`: verifies the server stays alive long enough
 * to serve requests and does NOT exit immediately after connect (Bug 1 regression).
 *
 * Spawns the built binary (`dist/cli.js mcp`) via StdioClientTransport with a
 * dummy private key so wallet_address can be derived locally (no network needed).
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it, vi } from "vitest";
import { startMcp } from "../src/mcp";

// Fakes the stdio TRANSPORT only (McpServer/Server stays real) so `startMcp` can be run
// in-process for the env-scrub assertion in "MCP server startup" below, without a REAL
// StdioServerTransport binding to THIS test process's actual stdin/stdout. The real class
// attaches `process.stdin.on("data", …)` synchronously inside `start()` — see
// node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js — which would hijack the
// shared vitest worker's stdio; every other test in this file avoids that by spawning a
// separate OS process instead. vi.hoisted is required here because vi.mock's factory runs
// before this file's own top-level statements (Vitest hoists vi.mock above all imports).
const { FakeStdioServerTransport } = vi.hoisted(() => {
  class FakeStdioServerTransport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: unknown, extra?: unknown) => void;
    start(): Promise<void> {
      return Promise.resolve();
    }
    close(): Promise<void> {
      this.onclose?.();
      return Promise.resolve();
    }
    send(): Promise<void> {
      return Promise.resolve();
    }
  }
  return { FakeStdioServerTransport };
});
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: FakeStdioServerTransport,
}));

const DUMMY_ENV = {
  ...process.env,
  AGENTKV_ENDPOINT: "https://example.invalid",
  AGENTKV_PRIVATE_KEY: "0x1111111111111111111111111111111111111111111111111111111111111111",
  AGENTKV_NETWORK: "eip155:8453",
};

// dist/cli.js relative to workspace root (cli/)
const CLI_PATH = join(import.meta.dirname, "..", "dist", "cli.js");

describe("MCP server lifecycle", () => {
  it("stays alive, lists 12 tools, and serves wallet_address without 'Connection closed'", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath, // node
      args: [CLI_PATH, "mcp"],
      env: DUMMY_ENV,
    });

    const client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(transport);

    // 1. List tools — the 6 core tools + list-keys + fund + the 4 LLM-free secret tools
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "agentkv_balance",
      "agentkv_delete",
      "agentkv_deposit",
      "agentkv_fund",
      "agentkv_get",
      "agentkv_get_to_file",
      "agentkv_list_keys",
      "agentkv_run_with_secret",
      "agentkv_set",
      "agentkv_set_from_env",
      "agentkv_set_from_file",
      "agentkv_wallet_address",
    ]);

    // 2. Call wallet_address — pure local derivation, no network
    const result = await client.callTool({ name: "agentkv_wallet_address", arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(1);
    const parsed = JSON.parse(content[0].text);
    expect(parsed.address).toMatch(/^0x[0-9a-fA-F]{40}$/);

    // 3. Clean shutdown
    await client.close();
  }, 15_000 /* generous timeout for process spawn */);

  // stdout hygiene: with NO wallet key, startMcp auto-provisions a wallet and emits the
  // "created a new wallet" notice — which MUST go to stderr, because stdout is the JSON-RPC
  // channel. A stray write to stdout corrupts the framing; the SDK transport surfaces that via
  // onerror. Assert no transport/client errors while tools still list (proving stderr, not stdout).
  it("auto-provision notice goes to stderr, not the JSON-RPC stdout channel", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentkv-prov-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_PATH, "mcp"],
      env: {
        ...process.env,
        AGENTKV_HOME: home, // isolate keystore -> forces a fresh auto-provision
        AGENTKV_ENDPOINT: "https://example.invalid",
        AGENTKV_PRIVATE_KEY: "", // empty -> unset: no wallet configured -> auto-provision fires
        AGENTKV_ACCOUNT_KEY: "", // empty -> not account mode
      },
    });
    const errors: unknown[] = [];
    transport.onerror = (e) => errors.push(e);
    const client = new Client({ name: "test-client", version: "0.0.1" });
    client.onerror = (e) => errors.push(e);
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(12); // handshake + listing succeeded ...
      expect(errors).toHaveLength(0); // ... with NO framing corruption from a stray stdout notice
    } finally {
      await client.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);

  // startMcp's real account-mode detection (cfg.accountKey != null …) is otherwise untested —
  // every unit test injects accountMode directly. If it regressed, a real account-key server
  // would report accountMode=false and agentkv_fund would emit a burn-address onramp URL.
  it("account-key env → wallet_address reports account-key mode and fund refuses (account_mode)", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentkv-acct-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_PATH, "mcp"],
      env: {
        ...process.env,
        AGENTKV_HOME: home,
        AGENTKV_ENDPOINT: "https://example.invalid",
        AGENTKV_ACCOUNT_KEY: `ak_${"a".repeat(64)}`,
        AGENTKV_ENCRYPTION_KEY: `0x${"b".repeat(64)}`,
        AGENTKV_PRIVATE_KEY: "", // must not override into wallet mode
      },
    });
    const client = new Client({ name: "test-client", version: "0.0.1" });
    try {
      await client.connect(transport);
      const wa = await client.callTool({ name: "agentkv_wallet_address", arguments: {} });
      const waParsed = JSON.parse((wa.content as Array<{ text: string }>)[0].text);
      expect(waParsed.mode).toBe("account-key");
      expect(waParsed.address).toBeNull(); // never the zero-address sentinel

      const f = await client.callTool({ name: "agentkv_fund", arguments: {} });
      expect(f.isError).toBe(true);
      expect(JSON.parse((f.content as Array<{ text: string }>)[0].text).code).toBe("account_mode");
    } finally {
      await client.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);
});

// Regression: nothing pinned that `startMcp` actually SCRUBS its own env at startup —
// neutering the `scrubSensitiveEnv(env)` call site in src/mcp.ts left the cli suite green,
// re-opening a path for an agent to read the funded payer key (or the wallet/encryption key)
// back out via set_from_env. secrets.test.ts pins scrubSensitiveEnv/isSensitiveEnvName/
// SENSITIVE_ENV/SENSITIVE_ENV_PATTERN directly; this pins the OTHER half — that startMcp calls it.
//
// Why this can't be observed over the wire like the tests above (per the task brief's own
// escape hatch): every tool that can read an env var re-checks isSensitiveEnvName
// INDEPENDENTLY of the startup scrub — agentkv_set_from_env via readEnvSecret, and
// agentkv_run_with_secret via runWithSecret's own inline strip loop (see cli/src/secrets.ts).
// So a spawned server's tool responses are IDENTICAL whether or not scrubSensitiveEnv ran at
// startup; there is no observable difference through the MCP wire protocol, spawned or not.
// This instead asserts the scrub at the point startMcp constructs the server: the real,
// unmodified startMcp runs in-process against an injected `env` object (the stdio transport
// is faked per the vi.mock above; McpServer/Server itself is the real, unmocked SDK code).
describe("MCP server startup: env scrub (server-construction level)", () => {
  it("startMcp deletes protected key vars from its own env before serving, leaving the rest", () => {
    const home = mkdtempSync(join(tmpdir(), "agentkv-scrub-"));
    const env = {
      AGENTKV_HOME: home,
      AGENTKV_ENDPOINT: "https://example.invalid",
      AGENTKV_PRIVATE_KEY: "0xdead",
      AGENTKV_PAYER_KEY: "0xbeef", // funded external payer — holds real USDC
      AGENTKV_WALLET_MNEMONIC: "twelve words",
      OPENAI_API_KEY: "sk-keepme", // third-party secret — storing these is the tool's purpose
    } as NodeJS.ProcessEnv;
    const client = {
      set: () => Promise.resolve({ ok: true }),
      get: () => Promise.resolve(null),
      delete: () => Promise.resolve({ ok: true }),
      deposit: () => Promise.resolve({}),
      balance: () => Promise.resolve(0),
      address: "0xabc",
    };
    try {
      // scrubSensitiveEnv runs synchronously inside startMcp, before its first `await`
      // (server.connect) — by the time this call returns control here, the mutation below
      // has already happened. The returned promise is deliberately not awaited: the fake
      // transport's onclose is never triggered so it never settles, but it holds no real OS
      // handle (stdin/stdout are never touched by FakeStdioServerTransport), so nothing
      // leaks or hangs — `.catch` just guards against an unhandled-rejection crash.
      void startMcp({ env, client: client as any }).catch(() => {});
      expect(env.AGENTKV_PRIVATE_KEY).toBeUndefined();
      expect(env.AGENTKV_PAYER_KEY).toBeUndefined();
      expect(env.AGENTKV_WALLET_MNEMONIC).toBeUndefined();
      expect(env.AGENTKV_ENDPOINT).toBe("https://example.invalid");
      expect(env.OPENAI_API_KEY).toBe("sk-keepme");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// Visibility, not a default cap: the MCP server is one long-lived client with NO cumulative
// spend bound by default. Rather than impose a default cap (which would silently change spend
// behavior for existing users), startMcp warns ONCE at startup when
// AGENTKV_MAX_SESSION_SPEND_USD is unset — so an operator who didn't intend an unbounded
// server finds out immediately instead of discovering it after the fact.
//
// Same in-process harness as the env-scrub block above: startMcp's config resolution + the
// warning check both run synchronously before its first `await` (server.connect), so the
// write (or non-write) has already happened by the time this synchronous call returns
// control here — see the comment on the scrub test for the full explanation. The writer is
// INJECTED (deps.stderr, the same `Writer` shape cli.ts's own stdout/stderr deps use) rather
// than captured off the real process.stderr, precisely so this stays a synchronous, in-process
// assertion instead of a real stdio/subprocess capture.
describe("MCP server startup: session spend cap warning", () => {
  // Never invoked — these tests only check what startMcp writes at startup.
  const client = {
    set: () => Promise.resolve({ ok: true }),
    get: () => Promise.resolve(null),
    delete: () => Promise.resolve({ ok: true }),
    deposit: () => Promise.resolve({}),
    balance: () => Promise.resolve(0),
    address: "0xabc",
  };

  it("warns on stderr when the server starts with no session spend cap", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentkv-warn-"));
    const env = {
      AGENTKV_HOME: home,
      AGENTKV_ENDPOINT: "https://example.invalid",
    } as NodeJS.ProcessEnv;
    const chunks: string[] = [];
    try {
      void startMcp({ env, client: client as any, stderr: (s) => chunks.push(s) }).catch(() => {});
      const written = chunks.join("");
      expect(written).toMatch(/no session spend cap configured/);
      expect(written).toContain("AGENTKV_MAX_SESSION_SPEND_USD");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("stays quiet when AGENTKV_MAX_SESSION_SPEND_USD is configured", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentkv-nowarn-"));
    const env = {
      AGENTKV_HOME: home,
      AGENTKV_ENDPOINT: "https://example.invalid",
      AGENTKV_MAX_SESSION_SPEND_USD: "5",
    } as NodeJS.ProcessEnv;
    const chunks: string[] = [];
    try {
      void startMcp({ env, client: client as any, stderr: (s) => chunks.push(s) }).catch(() => {});
      expect(chunks).toHaveLength(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === "win32")("CLI bin entry point", () => {
  it("runs when invoked via a POSIX symlink named `agentkv` (npm-install shape), not just dist/cli.js", () => {
    // npm installs the bin as a symlink `agentkv` -> dist/cli.js; Node does NOT realpath
    // argv[1] through it, so the old `endsWith("cli.js")` guard silently no-op'd (exit 0, no
    // output). Spawn via such a symlink and assert the command actually RAN (produced JSON).
    const linkDir = mkdtempSync(join(tmpdir(), "agentkv-bin-"));
    const home = mkdtempSync(join(tmpdir(), "agentkv-binhome-"));
    const link = join(linkDir, "agentkv");
    symlinkSync(CLI_PATH, link);
    try {
      const r = spawnSync(process.execPath, [link, "wallet", "show"], {
        env: { ...process.env, AGENTKV_HOME: home, AGENTKV_PRIVATE_KEY: "" },
        encoding: "utf8",
      });
      expect(r.status).toBe(0);
      expect(r.stdout.trim().length).toBeGreaterThan(0); // NOT a silent no-op
      // Fresh AGENTKV_HOME: `wallet show` reports no wallet yet, but it DID run and emit JSON.
      expect(JSON.parse(r.stdout)).toHaveProperty("note");
    } finally {
      rmSync(linkDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
