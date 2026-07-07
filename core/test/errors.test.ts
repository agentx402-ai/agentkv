// core/test/errors.test.ts
//
// Money/correctness: the error base must be a SINGLE class object in
// the installed workspace. `AgentKVError` is an ALIAS (`export { AgentXError as
// AgentKVError }`), not a second class declaration — these tests pin that the
// alias is the exact same reference, that `instanceof` holds both ways, and
// that `SpendCapError extends AgentKVError` keeps working through the alias.
//
// A companion test (`client/test/errors.test.ts`) proves the SAME guarantee
// holds across the actual package boundary once `@agentkv/client` re-exports
// this class (rather than re-declaring it) — see that file for the
// cross-package half of this pin.
import { describe, expect, it } from "vitest";
import { AgentKVError, AgentXError, SpendCapError } from "../src/errors";

describe("AgentKVError / AgentXError single-class invariant", () => {
  it("AgentKVError IS AgentXError — the alias is the same reference, not a re-declaration", () => {
    expect(AgentKVError).toBe(AgentXError);
  });

  it("new AgentKVError(...) instanceof AgentKVError holds (imported-name construction)", () => {
    const err = new AgentKVError("boom", "some_code", 500);
    expect(err).toBeInstanceOf(AgentKVError);
    expect(err).toBeInstanceOf(AgentXError);
    expect(err.code).toBe("some_code");
    expect(err.status).toBe(500);
    // Runtime `.name` is unchanged by the rename (only the exported identifier changed).
    expect(err.name).toBe("AgentKVError");
  });

  it("new AgentXError(...) instanceof AgentKVError holds (canonical-name construction)", () => {
    const err = new AgentXError("boom", "some_code");
    expect(err).toBeInstanceOf(AgentKVError);
  });

  it("SpendCapError extends AgentKVError through the alias", () => {
    const err = new SpendCapError("cap exceeded");
    expect(err).toBeInstanceOf(SpendCapError);
    expect(err).toBeInstanceOf(AgentKVError);
    expect(err).toBeInstanceOf(AgentXError);
    expect(err.code).toBe("spend_cap_exceeded");
    expect(err.name).toBe("SpendCapError");
  });
});
