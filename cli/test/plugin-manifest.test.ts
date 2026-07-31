import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The plugin's two manifests have to agree with each other, and nothing else checks that they do:
// CI validates they are well-formed JSON, never what is inside them. That gap shipped a real bug —
// plugin.json collected the user's account key in a sensitive field while .mcp.json never passed it
// to the server, so the value was silently discarded and account-key mode simply did not work.
// Both directions are failures, so both are pinned here:
//   declared but not passed  -> collected and thrown away (the bug above)
//   passed but not declared  -> always empty, because nothing ever populates it
const mcp = JSON.parse(
  readFileSync(new URL("../../plugin/agentkv/.mcp.json", import.meta.url), "utf8"),
) as { mcpServers: Record<string, { env: Record<string, string> }> };
const plugin = JSON.parse(
  readFileSync(new URL("../../plugin/agentkv/.claude-plugin/plugin.json", import.meta.url), "utf8"),
) as { userConfig: Record<string, unknown> };

const env = mcp.mcpServers.agentkv.env;
/** The `user_config.<name>` keys the server is actually handed, e.g. "${user_config.account_key:-}". */
const passedThrough = new Set(
  Object.values(env)
    .map((v) => /\$\{user_config\.([A-Za-z0-9_]+)/.exec(v)?.[1])
    .filter((k): k is string => k !== undefined),
);
const declared = new Set(Object.keys(plugin.userConfig));

describe("plugin manifests agree", () => {
  it("every declared userConfig field is passed to the server (none collected then discarded)", () => {
    expect([...declared].filter((k) => !passedThrough.has(k))).toEqual([]);
  });

  it("every user_config reference resolves to a declared field (none silently always-empty)", () => {
    expect([...passedThrough].filter((k) => !declared.has(k))).toEqual([]);
  });

  // Named explicitly because this is the one that regressed: it is the only way a managed-wallet
  // user can reach account-key mode at all, and losing it fails silently rather than loudly.
  it("the account key reaches the server", () => {
    expect(env.AGENTKV_ACCOUNT_KEY).toContain("user_config.account_key");
    expect(plugin.userConfig.account_key).toMatchObject({ sensitive: true });
  });

  // Key material must arrive as environment, never on a command line, where argv is readable by
  // other processes and lands in shell history.
  it("no key material is passed as a command-line argument", () => {
    const args = (mcp.mcpServers.agentkv as unknown as { args: string[] }).args;
    expect(args.some((a) => /user_config|key/i.test(a))).toBe(false);
  });
});
