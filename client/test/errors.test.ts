// client/test/errors.test.ts
//
// Money/correctness — the `instanceof` rule:
// `AgentKVError`/`SpendCapError` moved to `@agentx402-ai/core`. `@agentkv/client`
// must DEPEND ON and RE-EXPORT core's class (never re-declare it), or two
// distinct class objects would exist in the installed workspace and
// `err instanceof AgentKVError` would break for anything caught across this
// package boundary — e.g. `cli/src/config.ts`'s `throw new AgentKVError(...)`
// / `cli/src/cli.ts`'s `instanceof AgentKVError` dispatch.
//
// core/test/errors.test.ts pins the SAME guarantee at the core-internal level
// (the alias is the same reference). This file is the genuine cross-package
// proof: it imports core's class directly AND the client's re-exported name,
// and asserts they are the exact same class object and that `instanceof`
// holds in both directions through the module boundary.
import { AgentXError } from "@agentx402-ai/core";
import { describe, expect, it } from "vitest";
import { AgentKVError, SpendCapError } from "../src/types";

describe("AgentKVError re-export across the client/core package boundary", () => {
  it("client's re-exported AgentKVError IS core's AgentXError (single class object, not a re-declaration)", () => {
    expect(AgentKVError).toBe(AgentXError);
  });

  it("new AgentKVError(...) (constructed via the client re-export) instanceof AgentXError (constructed nowhere but core)", () => {
    const err = new AgentKVError("boom", "some_code", 500);
    expect(err).toBeInstanceOf(AgentXError);
    expect(err).toBeInstanceOf(AgentKVError);
    expect(err.code).toBe("some_code");
    expect(err.status).toBe(500);
  });

  it("new AgentXError(...) (constructed directly from core) instanceof AgentKVError (the client's re-exported name)", () => {
    const err = new AgentXError("boom", "some_code");
    expect(err).toBeInstanceOf(AgentKVError);
  });

  it("SpendCapError (re-exported from client) extends AgentKVError/AgentXError through the boundary", () => {
    const err = new SpendCapError("cap exceeded");
    expect(err).toBeInstanceOf(SpendCapError);
    expect(err).toBeInstanceOf(AgentKVError);
    expect(err).toBeInstanceOf(AgentXError);
    expect(err.code).toBe("spend_cap_exceeded");
  });
});
