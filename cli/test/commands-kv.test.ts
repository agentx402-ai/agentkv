import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli";

function fakeClient(overrides: Record<string, any> = {}) {
  return { ...defaultClient(), ...overrides };
}

function defaultClient() {
  return {
    set: vi.fn(async () => ({ ok: true, expires_at: null })),
    get: vi.fn(async () => ({ hello: "world" })),
    delete: vi.fn(async () => ({ ok: true })),
    balance: vi.fn(async () => 1000),
    deposit: vi.fn(async () => ({ credits_added: 5000, balance: 5000 })),
    address: "0xabc",
  };
}

describe("runKv — missing key", () => {
  it("get with no key → EXIT.USAGE and stderr code 'usage'", async () => {
    const err: string[] = [];
    const code = await runCli(["get"], {
      client: fakeClient() as any,
      stdout: () => {},
      stderr: (s) => err.push(s),
    });
    expect(code).toBe(2);
    const e = JSON.parse(err.join(""));
    expect(e.code).toBe("usage");
  });

  it("delete with no key → EXIT.USAGE and stderr code 'usage'", async () => {
    const err: string[] = [];
    const code = await runCli(["delete"], {
      client: fakeClient() as any,
      stdout: () => {},
      stderr: (s) => err.push(s),
    });
    expect(code).toBe(2);
    const e = JSON.parse(err.join(""));
    expect(e.code).toBe("usage");
  });

  it("set with no key → EXIT.USAGE and stderr code 'usage'", async () => {
    const err: string[] = [];
    const code = await runCli(["set"], {
      client: fakeClient() as any,
      stdout: () => {},
      stderr: (s) => err.push(s),
    });
    expect(code).toBe(2);
    const e = JSON.parse(err.join(""));
    expect(e.code).toBe("usage");
  });
});

describe("runKv — delete", () => {
  it("calls client.delete(key) and prints result, exits 0", async () => {
    const client = fakeClient();
    const out: string[] = [];
    const code = await runCli(["delete", "mykey"], {
      client: client as any,
      stdout: (s) => out.push(s),
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(client.delete).toHaveBeenCalledWith("mykey");
    expect(JSON.parse(out.join(""))).toEqual({ ok: true });
  });
});

describe("runKv — get", () => {
  it("get found: prints value and exits 0", async () => {
    const client = fakeClient({ get: vi.fn(async () => ({ hello: "world" })) });
    const out: string[] = [];
    const code = await runCli(["get", "mykey"], {
      client: client as any,
      stdout: (s) => out.push(s),
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(JSON.parse(out.join(""))).toEqual({ hello: "world" });
  });

  it("get → null: prints null and exits NOT_FOUND (4)", async () => {
    const client = fakeClient({ get: vi.fn(async () => null) });
    const out: string[] = [];
    const code = await runCli(["get", "mykey"], {
      client: client as any,
      stdout: (s) => out.push(s),
      stderr: () => {},
    });
    expect(code).toBe(4);
    expect(JSON.parse(out.join(""))).toBeNull();
  });

  it("get with --idempotency-key flag: forwards idempotencyKey to client.get", async () => {
    const client = fakeClient();
    const out: string[] = [];
    const code = await runCli(["get", "mykey", "--idempotency-key", "idem-abc"], {
      client: client as any,
      stdout: (s) => out.push(s),
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(client.get).toHaveBeenCalledWith("mykey", { idempotencyKey: "idem-abc" });
  });
});

describe("runKv — set", () => {
  it("set with positional JSON number: client.set called with parsed value, exits 0", async () => {
    const client = fakeClient();
    const out: string[] = [];
    const code = await runCli(["set", "mykey", "42"], {
      client: client as any,
      stdout: (s) => out.push(s),
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(client.set).toHaveBeenCalledWith("mykey", 42, {});
    expect(JSON.parse(out.join(""))).toEqual({ ok: true, expires_at: null });
  });

  it("set with positional JSON string: client.set called with parsed value", async () => {
    const client = fakeClient();
    const code = await runCli(["set", "mykey", '"a string"'], {
      client: client as any,
      stdout: () => {},
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(client.set).toHaveBeenCalledWith("mykey", "a string", {});
  });

  it("set with positional JSON object: client.set called with parsed value", async () => {
    const client = fakeClient();
    const code = await runCli(["set", "mykey", '{"k":"v"}'], {
      client: client as any,
      stdout: () => {},
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(client.set).toHaveBeenCalledWith("mykey", { k: "v" }, {});
  });

  it("set with INVALID JSON positional → EXIT.USAGE, stderr code 'invalid_value', client.set NOT called", async () => {
    const client = fakeClient();
    const err: string[] = [];
    const code = await runCli(["set", "mykey", "{bad"], {
      client: client as any,
      stdout: () => {},
      stderr: (s) => err.push(s),
    });
    expect(code).toBe(2);
    const e = JSON.parse(err.join(""));
    expect(e.code).toBe("invalid_value");
    expect(client.set).not.toHaveBeenCalled();
  });

  it("set with --ttl-days flag: opts.ttlDays is set", async () => {
    const client = fakeClient();
    const code = await runCli(["set", "mykey", "42", "--ttl-days", "7"], {
      client: client as any,
      stdout: () => {},
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(client.set).toHaveBeenCalledWith("mykey", 42, { ttlDays: 7 });
  });

  it("set with --strict-ttl flag: opts.strictTtl is true", async () => {
    const client = fakeClient();
    const code = await runCli(["set", "mykey", "42", "--strict-ttl"], {
      client: client as any,
      stdout: () => {},
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(client.set).toHaveBeenCalledWith("mykey", 42, { strictTtl: true });
  });

  it("set with --idempotency-key flag: opts.idempotencyKey is forwarded", async () => {
    const client = fakeClient();
    const code = await runCli(["set", "mykey", "42", "--idempotency-key", "idem-xyz"], {
      client: client as any,
      stdout: () => {},
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(client.set).toHaveBeenCalledWith("mykey", 42, { idempotencyKey: "idem-xyz" });
  });

  it("set with all three flags combined: all opts are forwarded", async () => {
    const client = fakeClient();
    const code = await runCli(
      ["set", "mykey", "42", "--ttl-days", "30", "--strict-ttl", "--idempotency-key", "combo-key"],
      {
        client: client as any,
        stdout: () => {},
        stderr: () => {},
      },
    );
    expect(code).toBe(0);
    expect(client.set).toHaveBeenCalledWith("mykey", 42, {
      ttlDays: 30,
      strictTtl: true,
      idempotencyKey: "combo-key",
    });
  });

  it("set with --file <path>: reads file and passes parsed contents to client.set", async () => {
    const tmpFile = join(tmpdir(), `agentkv-test-${Date.now()}.json`);
    const payload = { from: "file", num: 99 };
    writeFileSync(tmpFile, JSON.stringify(payload));

    const client = fakeClient();
    const out: string[] = [];
    const code = await runCli(["set", "filekey", "--file", tmpFile], {
      client: client as any,
      stdout: (s) => out.push(s),
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(client.set).toHaveBeenCalledWith("filekey", payload, {});
  });

  it("set with --file pointing to invalid JSON → EXIT.USAGE, code 'invalid_value'", async () => {
    const tmpFile = join(tmpdir(), `agentkv-test-bad-${Date.now()}.json`);
    writeFileSync(tmpFile, "{not valid json}");

    const client = fakeClient();
    const err: string[] = [];
    const code = await runCli(["set", "filekey", "--file", tmpFile], {
      client: client as any,
      stdout: () => {},
      stderr: (s) => err.push(s),
    });
    expect(code).toBe(2);
    const e = JSON.parse(err.join(""));
    expect(e.code).toBe("invalid_value");
    expect(client.set).not.toHaveBeenCalled();
  });
});

describe("runKv — secret flags (LLM-free)", () => {
  it("get --out FILE: writes the value to the file, prints only {found,path,bytes}, no secret on stdout", async () => {
    const SECRET = "sk-cli-SECRET-do-not-leak";
    const dest = join(tmpdir(), `agentkv-out-${Date.now()}`);
    const client = fakeClient({ get: vi.fn(async () => SECRET) });
    const out: string[] = [];
    const code = await runCli(["get", "k", "--out", dest], {
      client: client as any,
      stdout: (s) => out.push(s),
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(JSON.parse(out.join(""))).toMatchObject({ found: true, path: dest });
    expect(out.join("")).not.toContain(SECRET); // secret never on stdout
    expect(readFileSync(dest, "utf8")).toBe(SECRET); // secret is in the file
    rmSync(dest, { force: true });
  });

  it("get --out for a missing key: prints {found:false}, exits 4", async () => {
    const client = fakeClient({ get: vi.fn(async () => null) });
    const out: string[] = [];
    const code = await runCli(["get", "k", "--out", join(tmpdir(), `agentkv-none-${Date.now()}`)], {
      client: client as any,
      stdout: (s) => out.push(s),
      stderr: () => {},
    });
    expect(code).toBe(4);
    expect(JSON.parse(out.join(""))).toEqual({ found: false });
  });

  it("set --from-env VAR: stores the raw env value, never echoed to stdout", async () => {
    process.env.AGENTKV_CLI_SECRET = "env-secret-value";
    const client = fakeClient();
    const out: string[] = [];
    const code = await runCli(["set", "secret:k", "--from-env", "AGENTKV_CLI_SECRET"], {
      client: client as any,
      stdout: (s) => out.push(s),
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(client.set).toHaveBeenCalledWith("secret:k", "env-secret-value", {});
    expect(out.join("")).not.toContain("env-secret-value");
    delete process.env.AGENTKV_CLI_SECRET;
  });

  it("set --from-env with an unset var → EXIT.USAGE, code 'env_unset', client.set NOT called", async () => {
    delete process.env.AGENTKV_CLI_MISSING;
    const client = fakeClient();
    const err: string[] = [];
    const code = await runCli(["set", "k", "--from-env", "AGENTKV_CLI_MISSING"], {
      client: client as any,
      stdout: () => {},
      stderr: (s) => err.push(s),
    });
    expect(code).toBe(2);
    expect(JSON.parse(err.join("")).code).toBe("env_unset");
    expect(client.set).not.toHaveBeenCalled();
  });

  it("get --out to an existing path → write_failed (no clobber / symlink redirect)", async () => {
    const dest = join(tmpdir(), `agentkv-existing-out-${Date.now()}`);
    writeFileSync(dest, "pre-existing");
    const client = fakeClient({ get: vi.fn(async () => "secret") });
    const err: string[] = [];
    const code = await runCli(["get", "k", "--out", dest], {
      client: client as any,
      stdout: () => {},
      stderr: (s) => err.push(s),
    });
    expect(code).toBe(2);
    expect(JSON.parse(err.join("")).code).toBe("write_failed");
    expect(readFileSync(dest, "utf8")).toBe("pre-existing"); // untouched — secret not written through it
    rmSync(dest, { force: true });
  });

  it("get --out with NO value errors instead of leaking the secret to stdout", async () => {
    const SECRET = "sk-leak-me-DEADBEEF";
    const client = fakeClient({ get: vi.fn(async () => SECRET) });
    const out: string[] = [];
    const code = await runCli(["get", "k", "--out"], {
      client: client as any,
      stdout: (s) => out.push(s),
      stderr: () => {},
    });
    expect(code).not.toBe(0); // failed loud, did not fall through to printing
    expect(out.join("")).not.toContain(SECRET); // secret NEVER reached stdout
  });

  it("delete with --out errors (won't silently drop a 'backup' flag and destroy the value)", async () => {
    const client = fakeClient();
    const err: string[] = [];
    const code = await runCli(["delete", "k", "--out", "backup.json"], {
      client: client as any,
      stdout: () => {},
      stderr: (s) => err.push(s),
    });
    expect(code).toBe(2);
    expect(JSON.parse(err.join("")).code).toBe("usage");
    expect(client.delete).not.toHaveBeenCalled(); // key not destroyed
  });

  it("set --from-env refuses the wallet key (forbidden_env), without storing", async () => {
    process.env.AGENTKV_PRIVATE_KEY = "0xWALLET";
    const client = fakeClient();
    const err: string[] = [];
    try {
      const code = await runCli(["set", "x", "--from-env", "AGENTKV_PRIVATE_KEY"], {
        client: client as any,
        stdout: () => {},
        stderr: (s) => err.push(s),
      });
      expect(code).toBe(2);
      expect(JSON.parse(err.join("")).code).toBe("forbidden_env");
      expect(client.set).not.toHaveBeenCalled();
    } finally {
      delete process.env.AGENTKV_PRIVATE_KEY;
    }
  });
});

describe("runListKeys — pagination (list-keys)", () => {
  it("aggregates ALL pages by default and returns sorted keys with cursor:null", async () => {
    const pages: Record<string, { keys: string[]; cursor: string | null }> = {
      __start__: { keys: ["k2", "k1"], cursor: "a" },
      a: { keys: ["k4", "k3"], cursor: "b" },
      b: { keys: ["k5"], cursor: null },
    };
    const listKeys = vi.fn(async (opts: { cursor?: string | null; limit?: number } = {}) => {
      return pages[opts.cursor ?? "__start__"];
    });
    const out: string[] = [];
    const code = await runCli(["list-keys"], {
      client: fakeClient({ listKeys }) as any,
      stdout: (s) => out.push(s),
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(listKeys).toHaveBeenCalledTimes(3); // followed the cursor to exhaustion
    expect(JSON.parse(out.join(""))).toEqual({
      keys: ["k1", "k2", "k3", "k4", "k5"], // aggregated + sorted
      count: 5,
      cursor: null,
    });
  });

  it("--cursor fetches EXACTLY ONE page and returns that page's cursor (no follow)", async () => {
    const listKeys = vi.fn(async () => ({ keys: ["b", "a"], cursor: "next" }));
    const out: string[] = [];
    const code = await runCli(["list-keys", "--cursor", "here"], {
      client: fakeClient({ listKeys }) as any,
      stdout: (s) => out.push(s),
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(listKeys).toHaveBeenCalledTimes(1); // single page — did NOT follow "next"
    expect(listKeys).toHaveBeenCalledWith({ cursor: "here", limit: undefined });
    expect(JSON.parse(out.join(""))).toEqual({ keys: ["a", "b"], count: 2, cursor: "next" });
  });

  it("--limit is forwarded to the client as a NUMBER", async () => {
    const listKeys = vi.fn(async () => ({ keys: [], cursor: null }));
    const code = await runCli(["list-keys", "--limit", "2"], {
      client: fakeClient({ listKeys }) as any,
      stdout: () => {},
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(listKeys).toHaveBeenCalledWith({ limit: 2 }); // number, not the string "2"
  });
});
