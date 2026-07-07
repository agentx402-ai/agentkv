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
import { describe, expect, it } from "vitest";

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
