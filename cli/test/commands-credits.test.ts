import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli";

function fakeClient(overrides: Partial<ReturnType<typeof baseFakeClient>> = {}) {
  return { ...baseFakeClient(), ...overrides };
}

function baseFakeClient() {
  return {
    set: vi.fn(async () => ({ ok: true, expires_at: "x" })),
    get: vi.fn(async () => ({ hello: "world" })),
    delete: vi.fn(async () => ({ ok: true })),
    balance: vi.fn(async () => 994),
    deposit: vi.fn(async () => ({ credits_added: 5000, balance: 5000 })),
    address: "0xabc",
  };
}

describe("credits: balance command", () => {
  it("calls client.balance() and prints { balance } as JSON, exits OK (0)", async () => {
    const out: string[] = [];
    const client = fakeClient();
    const code = await runCli(["balance"], {
      client: client as any,
      stdout: (s) => out.push(s),
      stderr: () => {},
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join(""));
    expect(parsed).toEqual({ balance: 994 });
    expect(client.balance).toHaveBeenCalledTimes(1);
  });

  it("balance prints whatever numeric value client.balance() returns", async () => {
    const out: string[] = [];
    const client = fakeClient({ balance: vi.fn(async () => 0) });
    const code = await runCli(["balance"], {
      client: client as any,
      stdout: (s) => out.push(s),
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(JSON.parse(out.join(""))).toEqual({ balance: 0 });
  });
});

describe("credits: deposit command — valid amounts", () => {
  it("deposit '5' calls client.deposit(5) and prints result, exits OK", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const client = fakeClient();
    const code = await runCli(["deposit", "5"], {
      client: client as any,
      stdout: (s) => out.push(s),
      stderr: (s) => err.push(s),
    });
    expect(code).toBe(0);
    expect(client.deposit).toHaveBeenCalledWith(5);
    const parsed = JSON.parse(out.join(""));
    expect(parsed).toEqual({ credits_added: 5000, balance: 5000 });
    expect(err).toHaveLength(0);
  });

  it("deposit '1' (minimum) calls client.deposit(1), exits OK", async () => {
    const out: string[] = [];
    const client = fakeClient();
    const code = await runCli(["deposit", "1"], {
      client: client as any,
      stdout: (s) => out.push(s),
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(client.deposit).toHaveBeenCalledWith(1);
  });

  it("deposit '1.5' (non-integer but whole atomic) calls client.deposit(1.5), exits OK", async () => {
    // 1.5 * 1_000_000 = 1_500_000 === Math.round(1.5 * 1_000_000) → accepted
    const out: string[] = [];
    const client = fakeClient();
    const code = await runCli(["deposit", "1.5"], {
      client: client as any,
      stdout: (s) => out.push(s),
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(client.deposit).toHaveBeenCalledWith(1.5);
  });

  it("deposit '100' calls client.deposit(100), exits OK", async () => {
    const out: string[] = [];
    const client = fakeClient();
    const code = await runCli(["deposit", "100"], {
      client: client as any,
      stdout: (s) => out.push(s),
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(client.deposit).toHaveBeenCalledWith(100);
  });
});

describe("credits: deposit command — invalid amounts (USAGE errors)", () => {
  it("deposit '0.5' (below $1) exits USAGE (2) and does NOT call client.deposit", async () => {
    const err: string[] = [];
    const client = fakeClient();
    const code = await runCli(["deposit", "0.5"], {
      client: client as any,
      stdout: () => {},
      stderr: (s) => err.push(s),
    });
    expect(code).toBe(2);
    expect(client.deposit).not.toHaveBeenCalled();
    const parsed = JSON.parse(err.join(""));
    expect(parsed.code).toBe("usage");
    expect(parsed.error).toMatch(/deposit requires/);
  });

  it("deposit '0' exits USAGE and does NOT call client.deposit", async () => {
    const err: string[] = [];
    const client = fakeClient();
    const code = await runCli(["deposit", "0"], {
      client: client as any,
      stdout: () => {},
      stderr: (s) => err.push(s),
    });
    expect(code).toBe(2);
    expect(client.deposit).not.toHaveBeenCalled();
  });

  it("deposit '-1' exits USAGE and does NOT call client.deposit", async () => {
    const err: string[] = [];
    const client = fakeClient();
    const code = await runCli(["deposit", "-1"], {
      client: client as any,
      stdout: () => {},
      stderr: (s) => err.push(s),
    });
    expect(code).toBe(2);
    expect(client.deposit).not.toHaveBeenCalled();
  });

  it("deposit '1.0000001' (sub-atomic fractional) exits USAGE", async () => {
    // 1.0000001 * 1_000_000 = 1_000_000.1 !== 1_000_000 → rejected
    const err: string[] = [];
    const client = fakeClient();
    const code = await runCli(["deposit", "1.0000001"], {
      client: client as any,
      stdout: () => {},
      stderr: (s) => err.push(s),
    });
    expect(code).toBe(2);
    expect(client.deposit).not.toHaveBeenCalled();
  });

  it("deposit 'abc' (non-numeric) exits USAGE", async () => {
    const err: string[] = [];
    const client = fakeClient();
    const code = await runCli(["deposit", "abc"], {
      client: client as any,
      stdout: () => {},
      stderr: (s) => err.push(s),
    });
    expect(code).toBe(2);
    expect(client.deposit).not.toHaveBeenCalled();
    const parsed = JSON.parse(err.join(""));
    expect(parsed.code).toBe("usage");
  });

  it("deposit with no positional argument exits USAGE (Number(undefined) = NaN)", async () => {
    const err: string[] = [];
    const client = fakeClient();
    // No positional: positionals[0] is undefined → Number(undefined) = NaN
    const code = await runCli(["deposit"], {
      client: client as any,
      stdout: () => {},
      stderr: (s) => err.push(s),
    });
    expect(code).toBe(2);
    expect(client.deposit).not.toHaveBeenCalled();
  });

  it("deposit '' (empty string) exits USAGE (Number('') = 0, below $1)", async () => {
    const err: string[] = [];
    const client = fakeClient();
    const code = await runCli(["deposit", ""], {
      client: client as any,
      stdout: () => {},
      stderr: (s) => err.push(s),
    });
    expect(code).toBe(2);
    expect(client.deposit).not.toHaveBeenCalled();
  });

  it("deposit 'Infinity' exits USAGE (!Number.isFinite)", async () => {
    const err: string[] = [];
    const client = fakeClient();
    const code = await runCli(["deposit", "Infinity"], {
      client: client as any,
      stdout: () => {},
      stderr: (s) => err.push(s),
    });
    expect(code).toBe(2);
    expect(client.deposit).not.toHaveBeenCalled();
  });
});
