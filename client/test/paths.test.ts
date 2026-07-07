// client/test/paths.test.ts

import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentKV } from "../src/index";

const endpoint = "https://api.agentx402.ai";
const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const ENC_KEY = `0x${"22".repeat(32)}` as `0x${string}`;

// Wrap a real deterministic viem account so we can capture the EIP-712 "Request"
// (identity) path that is actually SIGNED — the exact string the worker verifies
// against the received pathname. If it ever differs from the fetched pathname,
// identity auth breaks. `{ signer, encryptionKey }` mode avoids sign-to-derive.
function recordingSigner() {
  const inner = privateKeyToAccount(PK);
  const signedPaths: string[] = [];
  const signer = {
    address: inner.address,
    signTypedData: (args: any) => {
      if (args.primaryType === "Request") signedPaths.push(args.message.path as string);
      return inner.signTypedData(args);
    },
    signMessage: (args: { message: string }) => inner.signMessage(args),
  };
  return { signer, signedPaths };
}

function mockFetch(calls: { url: string }[], body: unknown) {
  vi.stubGlobal("fetch", async (input: any) => {
    calls.push({ url: typeof input === "string" ? input : input.url });
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

afterEach(() => vi.restoreAllMocks());

describe("signed path == fetched pathname (divergence breaks identity auth)", () => {
  it("v1 delete: signs and fetches the SAME /v1 pathname", async () => {
    const { signer, signedPaths } = recordingSigner();
    const calls: { url: string }[] = [];
    mockFetch(calls, { ok: true });
    await new AgentKV({ signer, encryptionKey: ENC_KEY, endpoint }).delete("mykey");
    const fetchedPath = new URL(calls[0].url).pathname;
    expect(signedPaths[0]).toBe(fetchedPath); // the invariant
    expect(fetchedPath).toMatch(/^\/v1\/kv\//);
  });
  it("legacy delete: signs and fetches the SAME pathname, no /v1", async () => {
    const { signer, signedPaths } = recordingSigner();
    const calls: { url: string }[] = [];
    mockFetch(calls, { ok: true });
    await new AgentKV({ signer, encryptionKey: ENC_KEY, endpoint, apiVersion: "legacy" }).delete(
      "mykey",
    );
    const fetchedPath = new URL(calls[0].url).pathname;
    expect(signedPaths[0]).toBe(fetchedPath);
    expect(fetchedPath).toMatch(/^\/kv\//);
    expect(fetchedPath).not.toMatch(/\/v1\//);
  });
  it("v1 list-keys: signs and fetches /v1/kv; the query is on the URL only, never signed", async () => {
    const { signer, signedPaths } = recordingSigner();
    const calls: { url: string }[] = [];
    mockFetch(calls, { items: [], cursor: null });
    await new AgentKV({ signer, encryptionKey: ENC_KEY, endpoint }).listKeys({ limit: 10 });
    const u = new URL(calls[0].url);
    expect(u.pathname).toBe("/v1/kv");
    expect(signedPaths[0]).toBe(u.pathname); // pathname only
    expect(u.searchParams.get("limit")).toBe("10"); // query rides on the URL, not the signature
  });
  it("legacy list-keys: signs and fetches /list-keys", async () => {
    const { signer, signedPaths } = recordingSigner();
    const calls: { url: string }[] = [];
    mockFetch(calls, { items: [], cursor: null });
    await new AgentKV({
      signer,
      encryptionKey: ENC_KEY,
      endpoint,
      apiVersion: "legacy",
    }).listKeys();
    const u = new URL(calls[0].url);
    expect(u.pathname).toBe("/list-keys");
    expect(signedPaths[0]).toBe(u.pathname);
  });
  it("v1 balance: signs and fetches /v1/credits/balance", async () => {
    const { signer, signedPaths } = recordingSigner();
    const calls: { url: string }[] = [];
    mockFetch(calls, { balance: 0 });
    await new AgentKV({ signer, encryptionKey: ENC_KEY, endpoint }).balance();
    const p = new URL(calls[0].url).pathname;
    expect(p).toBe("/v1/credits/balance");
    expect(signedPaths[0]).toBe(p);
  });
});
