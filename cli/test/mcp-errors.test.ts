// cli/test/mcp-errors.test.ts
//
// The MCP boundary's SDK-error mapping. A tool that lets an AgentKVError escape gets
// flattened by the MCP SDK into a bare message string, which drops BOTH the `code` a
// model branches on and the worker's actionable `hint` — the caller is left with the
// worker's canned message ("invalid key") and no way to learn which rule it broke.
// The CLI's own hint printing is covered alongside it, since both boundaries read the
// same `AgentKVServiceError.hint`.

import { AgentKVError, kvErrorFromResponse } from "@agentkv/client";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli";
import { buildMcpServer } from "../src/mcp";

/** A worker 400 whose actionable detail lives in `hint`, mapped exactly as the SDK maps it. */
const invalidKeyError = () =>
  kvErrorFromResponse(
    400,
    JSON.stringify({
      error: "invalid key",
      code: "invalid_key",
      hint: "key must match [A-Za-z0-9._:-]{1,200}",
    }),
    "set failed",
  );

const clientWith = (overrides: Record<string, unknown>) =>
  ({
    set: async () => ({ ok: true }),
    get: async () => null,
    delete: async () => ({ ok: true }),
    deposit: async () => ({}),
    balance: async () => 0,
    listKeys: async () => ({ keys: [], cursor: null }),
    address: "0xabc",
    endpoint: "https://api.agentx402.ai",
    ...overrides,
  }) as any;

const envelope = (res: { content: Array<{ text: string }> }) => JSON.parse(res.content[0].text);

describe("MCP tools map SDK errors to the structured envelope", () => {
  it("surfaces the worker's code AND hint instead of a flattened message string", async () => {
    const server = buildMcpServer(
      clientWith({
        set: async () => {
          throw invalidKeyError();
        },
      }),
    );
    const tools = (server as any)._registeredTools;
    const res = await tools.agentkv_set.handler({ key: "bad key", value: 1 }, {});
    expect(res.isError).toBe(true);
    expect(envelope(res)).toMatchObject({
      code: "invalid_key",
      hint: "key must match [A-Za-z0-9._:-]{1,200}",
    });
  });

  it("omits `hint` entirely for a client-side throw, which carries none", async () => {
    const server = buildMcpServer(
      clientWith({
        get: async () => {
          throw new AgentKVError("no signer configured", "no_signer", 0);
        },
      }),
    );
    const tools = (server as any)._registeredTools;
    const res = await tools.agentkv_get.handler({ key: "k" }, {});
    expect(res.isError).toBe(true);
    const body = envelope(res);
    expect(body.code).toBe("no_signer");
    expect(body).not.toHaveProperty("hint");
  });

  it("maps the paid read tools too (get_to_file), not just the value-returning ones", async () => {
    const server = buildMcpServer(
      clientWith({
        get: async () => {
          throw invalidKeyError();
        },
      }),
    );
    const tools = (server as any)._registeredTools;
    const res = await tools.agentkv_get_to_file.handler({ key: "bad key" }, {});
    expect(res.isError).toBe(true);
    expect(envelope(res).hint).toBe("key must match [A-Za-z0-9._:-]{1,200}");
  });

  // A genuine bug must NOT be dressed up as a structured refusal — only SDK errors are
  // ours to translate; anything else keeps propagating so it surfaces as a real failure.
  it("lets a non-SDK error propagate rather than reporting it as a tool refusal", async () => {
    const server = buildMcpServer(
      clientWith({
        delete: async () => {
          throw new TypeError("undefined is not a function");
        },
      }),
    );
    const tools = (server as any)._registeredTools;
    await expect(tools.agentkv_delete.handler({ key: "k" }, {})).rejects.toThrow(TypeError);
  });
});

describe("CLI prints the worker's hint", () => {
  it("includes hint in the stderr envelope for a worker error that carries one", async () => {
    const err: string[] = [];
    const code = await runCli(["get", "bad key"], {
      client: clientWith({
        get: async () => {
          throw invalidKeyError();
        },
      }),
      stdout: () => {},
      stderr: (s) => err.push(s),
    });
    expect(code).not.toBe(0);
    const body = JSON.parse(err.join(""));
    expect(body.code).toBe("invalid_key");
    expect(body.hint).toBe("key must match [A-Za-z0-9._:-]{1,200}");
  });
});
