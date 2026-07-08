// cli/test/config-v1.test.ts
//
// clientFromConfig (cli/src/config.ts) spreads only
// { endpoint, network, maxSpendUsd, maxSessionSpendUsd } into every `new
// AgentKV(...)` it builds, so every CLI-built client targets `/v1/*` by
// construction. Asserted via `kvRoute()` — the path helper set/get/delete
// actually call — so a change to clientFromConfig's base spread (or the client's
// routing) is caught at the CLI boundary.
import { describe, expect, it } from "vitest";
import { clientFromConfig, type ResolvedConfig } from "../src/config";

describe("CLI client targets /v1 by default", () => {
  it("wallet mode (privateKey, no encryptionKey): kvRoute resolves under /v1", () => {
    const cfg: ResolvedConfig = {
      endpoint: "https://api.agentx402.ai",
      network: "eip155:8453",
      privateKey: `0x${"11".repeat(32)}` as `0x${string}`,
    };
    // clientFromConfig builds a client that targets /v1/*.
    const client = clientFromConfig(cfg) as any;
    expect(client.kvRoute("k").url).toMatch(/\/v1\/kv\/k$/);
    expect(client.kvRoute("k").path).toBe("/v1/kv/k");
  });

  it("account-key mode (accountKey + encryptionKey): kvRoute also resolves under /v1", () => {
    const cfg: ResolvedConfig = {
      endpoint: "https://api.agentx402.ai",
      network: "eip155:8453",
      accountKey: `ak_${"a".repeat(64)}`,
      encryptionKey: `0x${"22".repeat(32)}` as `0x${string}`,
    };
    const client = clientFromConfig(cfg) as any;
    expect(client.kvRoute("k").url).toMatch(/\/v1\/kv\/k$/);
  });
});
