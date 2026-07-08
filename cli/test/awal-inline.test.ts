// cli/test/awal-inline.test.ts — awal-subprocess opInlinePayer: argv construction (no
// shell), strict pre-spawn input validation, awal --json shape parsing (both the
// SUCCESS and FAILURE shapes C0 recorded live), and bearer redaction.
import { describe, expect, it } from "vitest";
import { AWAL_SPEC } from "../src/awal";
import { type AwalInlineExec, awalInlinePayer } from "../src/awalInline";

const AK = `ak_${"a".repeat(64)}`;
const HEADERS = {
  Authorization: `Bearer ${AK}`,
  "Idempotency-Key": "idem-1",
  "content-type": "application/json",
};
const REQ = {
  url: "https://api.agentx402.ai/v1/kv/abcdef0123456789",
  method: "POST" as const,
  body: JSON.stringify({ value: "CIPHERTEXT" }),
  headers: HEADERS,
  maxAmountAtomic: 1_000_000,
};

function successStdout(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    status: 200,
    statusText: "OK",
    data: { ok: true, expires_at: "2099-01-01T00:00:00Z" },
    headers: { "content-type": "application/json" },
    ...overrides,
  });
}

function capturingExec(stdout = successStdout()) {
  const calls: Array<{ cmd: string; args: string[]; timeoutMs: number }> = [];
  const exec: AwalInlineExec = async (cmd, args, opts) => {
    calls.push({ cmd, args, timeoutMs: opts.timeoutMs });
    return { stdout };
  };
  return { calls, exec };
}

describe("awalInlinePayer — argv construction", () => {
  it("builds the exact argv (no shell string) for a POST request", async () => {
    const { calls, exec } = capturingExec();
    await awalInlinePayer(exec)(REQ);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("npx");
    expect(calls[0].args).toEqual([
      "-y",
      AWAL_SPEC,
      "x402",
      "pay",
      REQ.url,
      "-X",
      "POST",
      "-d",
      REQ.body,
      "-h",
      JSON.stringify(HEADERS),
      "--max-amount",
      "1000000",
      "--json",
    ]);
    expect(calls[0].timeoutMs).toBe(120_000);
  });

  it("omits -d for a GET request (no body)", async () => {
    const { calls, exec } = capturingExec();
    const getReq = { ...REQ, method: "GET" as const, body: undefined };
    await awalInlinePayer(exec)(getReq);
    expect(calls[0].args).toEqual([
      "-y",
      AWAL_SPEC,
      "x402",
      "pay",
      REQ.url,
      "-X",
      "GET",
      "-h",
      JSON.stringify(HEADERS),
      "--max-amount",
      "1000000",
      "--json",
    ]);
  });
});

describe("awalInlinePayer — awal --json SUCCESS shape", () => {
  it("parses {status, statusText, data, headers} into {status, body: JSON.stringify(data), headers}", async () => {
    const { exec } = capturingExec(successStdout());
    const res = await awalInlinePayer(exec)(REQ);
    expect(res).toEqual({
      status: 200,
      body: JSON.stringify({ ok: true, expires_at: "2099-01-01T00:00:00Z" }),
      headers: { "content-type": "application/json" },
    });
  });

  it("re-stringifies a null data payload rather than passing it through raw", async () => {
    const { exec } = capturingExec(successStdout({ data: null }));
    const res = await awalInlinePayer(exec)(REQ);
    expect(res.body).toBe("null");
  });

  it("defaults headers to {} when awal omits them", async () => {
    const { exec } = capturingExec(
      JSON.stringify({ status: 200, statusText: "OK", data: { ok: true } }),
    );
    const res = await awalInlinePayer(exec)(REQ);
    expect(res.headers).toEqual({});
  });
});

describe("awalInlinePayer — awal --json FAILURE shape", () => {
  it("throws with awal's error message on {success:false, error}", async () => {
    const { exec } = capturingExec(
      JSON.stringify({
        success: false,
        error: { code: "REQUEST_FAILED", message: "x402 request failed: insufficient balance" },
      }),
    );
    await expect(awalInlinePayer(exec)(REQ)).rejects.toThrow(/insufficient balance/);
  });

  it("REDACTS the bearer when it appears inside awal's error.message", async () => {
    const { exec } = capturingExec(
      JSON.stringify({
        success: false,
        error: { code: "REQUEST_FAILED", message: `x402 request failed: bad bearer Bearer ${AK}` },
      }),
    );
    await expect(awalInlinePayer(exec)(REQ)).rejects.toThrow(/ak_…/);
    await expect(awalInlinePayer(exec)(REQ)).rejects.not.toThrow(new RegExp(AK));
  });
});

describe("awalInlinePayer — pre-spawn validation (fail closed, no spawn)", () => {
  it("rejects a missing/malformed bearer BEFORE spawning", async () => {
    const { calls, exec } = capturingExec();
    await expect(
      awalInlinePayer(exec)({ ...REQ, headers: { ...HEADERS, Authorization: "Bearer ak_short" } }),
    ).rejects.toThrow(/bearer/i);
    await expect(
      awalInlinePayer(exec)({ ...REQ, headers: { "Idempotency-Key": "x" } }),
    ).rejects.toThrow(/bearer/i);
    expect(calls).toHaveLength(0);
  });

  it("rejects a non-http(s) or unparseable url BEFORE spawning", async () => {
    const { calls, exec } = capturingExec();
    await expect(awalInlinePayer(exec)({ ...REQ, url: "file:///etc/passwd" })).rejects.toThrow(
      /url/i,
    );
    await expect(awalInlinePayer(exec)({ ...REQ, url: "not a url" })).rejects.toThrow(/url/i);
    expect(calls).toHaveLength(0);
  });

  it("rejects a url whose path does not start with /kv/ BEFORE spawning", async () => {
    const { calls, exec } = capturingExec();
    await expect(
      awalInlinePayer(exec)({ ...REQ, url: "https://api.agentx402.ai/account/deposit" }),
    ).rejects.toThrow(/kv/i);
    expect(calls).toHaveLength(0);
  });

  it("rejects a /v1 url whose path does not start with /v1/kv/ BEFORE spawning", async () => {
    const { calls, exec } = capturingExec();
    await expect(
      awalInlinePayer(exec)({ ...REQ, url: "https://api.agentx402.ai/v1/account/deposit" }),
    ).rejects.toThrow(/kv/i);
    expect(calls).toHaveLength(0);
  });

  it("accepts a legacy (unversioned) /kv/ url", async () => {
    const { calls, exec } = capturingExec();
    await awalInlinePayer(exec)({
      ...REQ,
      url: "https://api.agentx402.ai/kv/abcdef0123456789",
    });
    expect(calls).toHaveLength(1);
  });

  it("rejects a non-positive-integer maxAmountAtomic BEFORE spawning", async () => {
    const { calls, exec } = capturingExec();
    await expect(awalInlinePayer(exec)({ ...REQ, maxAmountAtomic: 1.5 })).rejects.toThrow(/max/i);
    await expect(awalInlinePayer(exec)({ ...REQ, maxAmountAtomic: 0 })).rejects.toThrow(/max/i);
    expect(calls).toHaveLength(0);
  });

  it("rejects a method outside {POST, GET} BEFORE spawning", async () => {
    const { calls, exec } = capturingExec();
    const badMethodReq = { ...REQ, method: "DELETE" } as unknown as typeof REQ;
    await expect(awalInlinePayer(exec)(badMethodReq)).rejects.toThrow(/method/i);
    expect(calls).toHaveLength(0);
  });
});

describe("awalInlinePayer — unparseable output / subprocess errors", () => {
  it("throws when awal's stdout is not parseable JSON", async () => {
    const { exec } = capturingExec("payment maybe went through?");
    await expect(awalInlinePayer(exec)(REQ)).rejects.toThrow();
  });

  it("REDACTS the bearer from subprocess error messages (execFile embeds argv)", async () => {
    const exec: AwalInlineExec = async () => {
      throw new Error(`Command failed: npx -y awal x402 pay … Bearer ${AK} …`);
    };
    await expect(awalInlinePayer(exec)(REQ)).rejects.toThrow(/ak_…/);
    await expect(awalInlinePayer(exec)(REQ)).rejects.not.toThrow(new RegExp(AK));
  });
});
