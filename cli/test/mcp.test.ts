import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildMcpServer } from "../src/mcp";

describe("MCP tools", () => {
  it("registers the six agentkv tools", () => {
    const client = {
      set: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
      deposit: vi.fn(),
      balance: vi.fn(),
      address: "0xabc",
    };
    const server = buildMcpServer(client as any);
    // _registeredTools is a plain object keyed by tool name in SDK 1.29.0 runtime
    const names = Object.keys((server as any)._registeredTools);
    for (const t of [
      "agentkv_set",
      "agentkv_get",
      "agentkv_delete",
      "agentkv_deposit",
      "agentkv_balance",
      "agentkv_wallet_address",
    ]) {
      expect(names).toContain(t);
    }
  });

  it("agentkv_set and agentkv_get forward idempotency_key to the client (exactly-once over MCP)", async () => {
    const calls: Record<string, any[][]> = { set: [], get: [] };
    const client = {
      set: async (...a: any[]) => {
        calls.set.push(a);
        return { ok: true };
      },
      get: async (...a: any[]) => {
        calls.get.push(a);
        return null;
      },
      delete: async () => ({ ok: true }),
      deposit: async () => ({}),
      balance: async () => 0,
      address: "0xabc",
    };
    const server = buildMcpServer(client as any);
    const tools = (server as any)._registeredTools;
    await tools.agentkv_set.handler({ key: "k", value: 1, idempotency_key: "idem-1" }, {});
    await tools.agentkv_get.handler({ key: "k", idempotency_key: "idem-2" }, {});
    expect(calls.set[0][2]).toMatchObject({ idempotencyKey: "idem-1" }); // set opts (3rd arg)
    expect(calls.get[0][1]).toMatchObject({ idempotencyKey: "idem-2" }); // get opts (2nd arg)
  });

  it("agentkv_delete forwards the key to client.delete", async () => {
    const calls: any[][] = [];
    const client = {
      set: async () => ({ ok: true }),
      get: async () => null,
      delete: async (...a: any[]) => {
        calls.push(a);
        return { ok: true };
      },
      deposit: async () => ({}),
      balance: async () => 0,
      address: "0xabc",
    };
    const server = buildMcpServer(client as any);
    const tools = (server as any)._registeredTools;
    const res = await tools.agentkv_delete.handler({ key: "session" }, {});
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("session"); // delete invoked with the key
    expect(res).toBeDefined(); // handler returns an MCP result
  });
});

describe("MCP account-key mode awareness", () => {
  const ZERO = "0x0000000000000000000000000000000000000000";
  const WALLET_ADDR = "0xabc0000000000000000000000000000000000000";
  const ONRAMP = { provider: "coinbase", network: "eip155:8453", config: { appId: "proj-x" } };

  function fakeClient(over: Record<string, unknown> = {}) {
    return {
      set: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
      deposit: vi.fn(),
      balance: vi.fn(),
      listKeys: vi.fn(),
      address: WALLET_ADDR,
      endpoint: "https://staging.example",
      ...over,
    };
  }
  const toolsFor = (client: any, accountMode: boolean) =>
    (buildMcpServer(client, ONRAMP, accountMode) as any)._registeredTools;

  it("wallet mode: wallet_address returns the real address and fund builds a real onramp URL", async () => {
    const tools = toolsFor(fakeClient(), false);

    const addr = JSON.parse((await tools.agentkv_wallet_address.handler({}, {})).content[0].text);
    expect(addr.address).toBe(WALLET_ADDR);
    expect(addr.mode).toBeUndefined();

    const fund = await tools.agentkv_fund.handler({}, {});
    expect(fund.isError).toBeFalsy();
    const body = JSON.parse(fund.content[0].text);
    expect(body.url).toContain("pay.coinbase.com");
    expect(body.address).toBe(WALLET_ADDR);
  });

  it("wallet mode on a TESTNET network: fund is isError (onramp_config), NEVER a mainnet URL", async () => {
    // A testnet-configured MCP server must surface a clean tool error, not a real mainnet
    // Coinbase Onramp URL (which would buy real mainnet USDC).
    const testnetOnramp = {
      provider: "coinbase",
      network: "eip155:84532",
      config: { appId: "proj-x" },
    };
    const tools = (buildMcpServer(fakeClient() as any, testnetOnramp, false) as any)
      ._registeredTools;
    const res = await tools.agentkv_fund.handler({}, {});
    expect(res.isError).toBe(true);
    const body = JSON.parse(res.content[0].text);
    expect(body.code).toBe("onramp_config");
    expect(body.error).toMatch(/testnet|Base mainnet only/i);
    expect(res.content[0].text).not.toContain("pay.coinbase.com");
  });

  it("account mode: wallet_address reports account-key mode, never the zero-address sentinel", async () => {
    const tools = toolsFor(fakeClient({ address: ZERO }), true);
    const res = await tools.agentkv_wallet_address.handler({}, {});
    const body = JSON.parse(res.content[0].text);
    expect(body.mode).toBe("account-key");
    expect(body.address).toBeNull();
    expect(body.note).toMatch(/bearer key/i);
    // The misleading zero-address sentinel must NOT be surfaced.
    expect(res.content[0].text).not.toContain(ZERO);
  });

  it("account mode: fund REFUSES (isError account_mode) with deposit instructions, NO burn-address URL", async () => {
    const tools = toolsFor(fakeClient({ address: ZERO }), true);
    const res = await tools.agentkv_fund.handler({ amount_usd: 25 }, {});
    expect(res.isError).toBe(true);
    const body = JSON.parse(res.content[0].text);
    expect(body.code).toBe("account_mode");
    // Points at the configured endpoint's /account/deposit (mirrors runFund's guidance).
    expect(body.error).toContain("https://staging.example/account/deposit");
    // Never an onramp URL, and never the zero-address the burn bug would have targeted.
    expect(res.content[0].text).not.toContain("pay.coinbase.com");
    expect(res.content[0].text).not.toContain(ZERO);
  });

  it("account mode: fund refuses BEFORE onramp config is consulted (even with onramp omitted)", async () => {
    // accountMode guard must precede the onramp-unavailable check — no burn URL regardless.
    const tools = (buildMcpServer(fakeClient({ address: ZERO }) as any, undefined, true) as any)
      ._registeredTools;
    const res = await tools.agentkv_fund.handler({}, {});
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).code).toBe("account_mode");
  });

  // FIX 2: in account mode client.deposit() always throws no_signer. agentkv_deposit must be
  // gated (like agentkv_fund) with a clean structured error, never a raw throw.
  it("account mode: deposit REFUSES (isError account_mode) with deposit instructions, no raw no_signer", async () => {
    const deposit = vi.fn(async () => {
      throw new Error("no_signer");
    });
    const tools = toolsFor(fakeClient({ address: ZERO, deposit }), true);
    const res = await tools.agentkv_deposit.handler({ amount_usd: 5 }, {});
    expect(res.isError).toBe(true);
    const body = JSON.parse(res.content[0].text);
    expect(body.code).toBe("account_mode");
    expect(body.error).toContain("https://staging.example/account/deposit");
    expect(body.error).not.toContain("no_signer");
    expect(deposit).not.toHaveBeenCalled(); // never forwarded to the raw-throwing client
  });

  it("wallet mode: deposit forwards to client.deposit (unchanged)", async () => {
    const deposit = vi.fn(async () => ({ credited: 5 }));
    const tools = toolsFor(fakeClient({ deposit }), false);
    const res = await tools.agentkv_deposit.handler({ amount_usd: 5 }, {});
    expect(res.isError).toBeFalsy();
    expect(deposit).toHaveBeenCalledWith(5);
    expect(JSON.parse(res.content[0].text)).toEqual({ credited: 5 });
  });
});

describe("MCP secret tools (LLM-free)", () => {
  const SECRET = "sk-live-DEADBEEF-do-not-leak";

  function secretClient(store: Record<string, unknown> = {}) {
    return {
      set: vi.fn(async (k: string, v: unknown) => {
        store[k] = v;
        return { ok: true };
      }),
      get: vi.fn(async (k: string) => (k in store ? store[k] : null)),
      delete: vi.fn(async () => ({ ok: true })),
      deposit: vi.fn(async () => ({})),
      balance: vi.fn(async () => 0),
      address: "0xabc",
    };
  }
  const toolsOf = (store?: Record<string, unknown>) =>
    (buildMcpServer(secretClient(store) as any) as any)._registeredTools;

  it("registers the four LLM-free secret tools", () => {
    const names = Object.keys(toolsOf());
    for (const t of [
      "agentkv_set_from_env",
      "agentkv_set_from_file",
      "agentkv_get_to_file",
      "agentkv_run_with_secret",
    ]) {
      expect(names).toContain(t);
    }
  });

  it("set_from_env: reads the env var locally, stores it, and the secret is not in the return", async () => {
    process.env.AGENTKV_TEST_SECRET = SECRET;
    const store: Record<string, unknown> = {};
    const res = await toolsOf(store).agentkv_set_from_env.handler(
      { key: "secret:x", env_var: "AGENTKV_TEST_SECRET" },
      {},
    );
    expect(store["secret:x"]).toBe(SECRET);
    expect(JSON.stringify(res)).not.toContain(SECRET);
    delete process.env.AGENTKV_TEST_SECRET;
  });

  it("set_from_env: errors (env_unset) when the var is unset, without storing", async () => {
    delete process.env.AGENTKV_MISSING;
    const store: Record<string, unknown> = {};
    const res = await toolsOf(store).agentkv_set_from_env.handler(
      { key: "k", env_var: "AGENTKV_MISSING" },
      {},
    );
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).code).toBe("env_unset");
    expect(Object.keys(store)).toHaveLength(0);
  });

  it("set_from_file: reads the file locally and trims a trailing newline", async () => {
    const f = join(tmpdir(), `agentkv-secret-${Date.now()}`);
    writeFileSync(f, `${SECRET}\n`);
    const store: Record<string, unknown> = {};
    await toolsOf(store).agentkv_set_from_file.handler({ key: "secret:y", path: f }, {});
    expect(store["secret:y"]).toBe(SECRET); // newline trimmed
    rmSync(f, { force: true });
  });

  it("get_to_file: writes the value to a file, returns {found,path,bytes} only — never the value", async () => {
    const res = await toolsOf({ "secret:z": SECRET }).agentkv_get_to_file.handler(
      { key: "secret:z" },
      {},
    );
    const out = JSON.parse(res.content[0].text);
    expect(out.found).toBe(true);
    expect(out.bytes).toBe(Buffer.byteLength(SECRET, "utf8"));
    expect(readFileSync(out.path, "utf8")).toBe(SECRET); // value materialized on disk
    expect(JSON.stringify(res)).not.toContain(SECRET); // NOT in the model-facing return
    rmSync(out.path, { force: true });
  });

  it("get_to_file: returns {found:false} for a missing key", async () => {
    const res = await toolsOf().agentkv_get_to_file.handler({ key: "nope" }, {});
    expect(JSON.parse(res.content[0].text)).toEqual({ found: false });
  });

  it("run_with_secret: injects the secret into the child env and returns output, never the secret", async () => {
    const res = await toolsOf({ "secret:run": SECRET }).agentkv_run_with_secret.handler(
      {
        key: "secret:run",
        env_var: "INJECTED",
        command: process.execPath,
        args: ["-e", "process.stdout.write(String((process.env.INJECTED||'').length))"],
      },
      {},
    );
    const out = JSON.parse(res.content[0].text);
    expect(out.exit_code).toBe(0);
    expect(out.stdout).toBe(String(SECRET.length)); // child got the full secret via env
    expect(JSON.stringify(res)).not.toContain(SECRET); // never echoed to the model
  });

  it("run_with_secret: errors (not_found) for a missing key", async () => {
    const res = await toolsOf().agentkv_run_with_secret.handler(
      { key: "nope", env_var: "X", command: process.execPath, args: ["-e", "0"] },
      {},
    );
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).code).toBe("not_found");
  });

  it("run_with_secret: refuses a process-hijack env var (forbidden_env), without reading the secret", async () => {
    const client = secretClient({ "secret:run": SECRET });
    const tools = (buildMcpServer(client as any) as any)._registeredTools;
    const res = await tools.agentkv_run_with_secret.handler(
      { key: "secret:run", env_var: "LD_PRELOAD", command: process.execPath, args: ["-e", "0"] },
      {},
    );
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).code).toBe("forbidden_env");
    expect(client.get).not.toHaveBeenCalled(); // fail-fast: secret never fetched
  });

  it("set_from_env: refuses to read the wallet key (forbidden_env), without storing", async () => {
    process.env.AGENTKV_PRIVATE_KEY = "0xWALLET-do-not-leak";
    const store: Record<string, unknown> = {};
    try {
      const res = await toolsOf(store).agentkv_set_from_env.handler(
        { key: "x", env_var: "AGENTKV_PRIVATE_KEY" },
        {},
      );
      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content[0].text).code).toBe("forbidden_env");
      expect(Object.keys(store)).toHaveLength(0); // wallet key never stored
      expect(JSON.stringify(res)).not.toContain("0xWALLET-do-not-leak");
    } finally {
      delete process.env.AGENTKV_PRIVATE_KEY;
    }
  });

  it("run_with_secret: a nonexistent command returns structured spawn_failed (not a raw throw)", async () => {
    const res = await toolsOf({ "secret:run": SECRET }).agentkv_run_with_secret.handler(
      { key: "secret:run", env_var: "SEC", command: "agentkv-no-such-binary-xyz", args: [] },
      {},
    );
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).code).toBe("spawn_failed");
  });
});
