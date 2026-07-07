// cli/test/awal.test.ts — awal-subprocess topoffPayer: argv construction (no shell),
// strict input validation, settlement confirmation, bearer redaction.
import { describe, expect, it } from "vitest";
import { AWAL_SPEC, type AwalExec, awalTopoffPayer } from "../src/awal";

const AK = `ak_${"a".repeat(64)}`;
const REQ = {
  depositUrl: "https://api.agentx402.ai/v1/account/deposit",
  accountKey: AK,
  amountUsd: 1,
  maxAmountAtomic: 1_000_000,
};

function capturingExec(stdout = JSON.stringify({ status: 200 })) {
  const calls: Array<{ cmd: string; args: string[]; timeoutMs: number }> = [];
  const exec: AwalExec = async (cmd, args, opts) => {
    calls.push({ cmd, args, timeoutMs: opts.timeoutMs });
    return { stdout };
  };
  return { calls, exec };
}

describe("awalTopoffPayer", () => {
  it("builds the exact argv (no shell string) with pinned awal, bearer header, max-amount, json", async () => {
    const { calls, exec } = capturingExec();
    await awalTopoffPayer(exec)(REQ);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("npx");
    expect(calls[0].args).toEqual([
      "-y",
      AWAL_SPEC,
      "x402",
      "pay",
      REQ.depositUrl,
      "-X",
      "POST",
      "-h",
      JSON.stringify({ Authorization: `Bearer ${AK}` }),
      "--max-amount",
      "1000000",
      "--json",
    ]);
    expect(calls[0].timeoutMs).toBe(120_000);
  });

  it("rejects a malformed bearer BEFORE spawning", async () => {
    const { calls, exec } = capturingExec();
    await expect(
      awalTopoffPayer(exec)({ ...REQ, accountKey: "ak_short; rm -rf /" }),
    ).rejects.toThrow(/account key/i);
    expect(calls).toHaveLength(0);
  });

  it("rejects a depositUrl whose path is not /account/deposit BEFORE spawning", async () => {
    const { calls, exec } = capturingExec();
    await expect(
      awalTopoffPayer(exec)({ ...REQ, depositUrl: "https://api.agentx402.ai/kv/abc" }),
    ).rejects.toThrow(/deposit/i);
    expect(calls).toHaveLength(0);
  });

  it("rejects a /v1 depositUrl whose path is not /v1/account/deposit BEFORE spawning", async () => {
    const { calls, exec } = capturingExec();
    await expect(
      awalTopoffPayer(exec)({ ...REQ, depositUrl: "https://api.agentx402.ai/v1/kv/abc" }),
    ).rejects.toThrow(/deposit/i);
    expect(calls).toHaveLength(0);
  });

  it("accepts a legacy (unversioned) /account/deposit depositUrl", async () => {
    const { calls, exec } = capturingExec();
    await awalTopoffPayer(exec)({
      ...REQ,
      depositUrl: "https://api.agentx402.ai/account/deposit",
    });
    expect(calls).toHaveLength(1);
  });

  it("rejects a non-https/http or unparseable depositUrl BEFORE spawning", async () => {
    const { calls, exec } = capturingExec();
    await expect(
      awalTopoffPayer(exec)({ ...REQ, depositUrl: "file:///etc/passwd" }),
    ).rejects.toThrow(/url/i);
    await expect(awalTopoffPayer(exec)({ ...REQ, depositUrl: "not a url" })).rejects.toThrow(
      /url/i,
    );
    expect(calls).toHaveLength(0);
  });

  it("rejects a non-positive-integer maxAmountAtomic BEFORE spawning", async () => {
    const { calls, exec } = capturingExec();
    await expect(awalTopoffPayer(exec)({ ...REQ, maxAmountAtomic: 1.5 })).rejects.toThrow(/max/i);
    await expect(awalTopoffPayer(exec)({ ...REQ, maxAmountAtomic: 0 })).rejects.toThrow(/max/i);
    expect(calls).toHaveLength(0);
  });

  it("rejects when awal output is not parseable JSON (settlement unconfirmed)", async () => {
    const { exec } = capturingExec("payment maybe went through?");
    await expect(awalTopoffPayer(exec)(REQ)).rejects.toThrow(/confirm/i);
  });

  it("rejects when awal reports an error field", async () => {
    const { exec } = capturingExec(JSON.stringify({ error: "insufficient balance" }));
    await expect(awalTopoffPayer(exec)(REQ)).rejects.toThrow(/insufficient balance/);
  });

  it("REDACTS the bearer when it appears inside awal's parsed out.error field", async () => {
    const { exec } = capturingExec(JSON.stringify({ error: `payment failed for Bearer ${AK}` }));
    await expect(awalTopoffPayer(exec)(REQ)).rejects.toThrow(/ak_…/);
    await expect(awalTopoffPayer(exec)(REQ)).rejects.not.toThrow(new RegExp(AK));
  });

  it("REDACTS the bearer from subprocess error messages (execFile embeds argv)", async () => {
    const exec: AwalExec = async () => {
      throw new Error(`Command failed: npx -y awal x402 pay … Bearer ${AK} …`);
    };
    await expect(awalTopoffPayer(exec)(REQ)).rejects.toThrow(/ak_…/);
    await expect(awalTopoffPayer(exec)(REQ)).rejects.not.toThrow(new RegExp(AK));
  });
});
