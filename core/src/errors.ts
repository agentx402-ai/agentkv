// core/src/errors.ts
//
// The SINGLE error base class object for the installed workspace. `@agentkv/client`
// (and any future second service package) must DEPEND ON and RE-EXPORT this class —
// never re-declare it — or `err instanceof AgentKVError` breaks for anything caught
// across a package boundary (two distinct class objects in node_modules).

/** Base error carrying a machine code (mapped to CLI exit codes / MCP errors). */
export class AgentXError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(message);
    // Keep the original runtime `.name` string ("AgentKVError") so any existing
    // logging/serialization that reads `err.name` sees no observable change from
    // the pre-extraction class — only the exported IDENTIFIER is renamed.
    this.name = "AgentKVError";
  }
}

/**
 * Back-compat alias: the base class shipped as `AgentKVError` before this
 * extraction. Re-export the SAME reference under the old name (not a second
 * `class AgentKVError extends AgentXError {}` declaration) so
 * `new AgentKVError(...) instanceof AgentKVError` and
 * `new AgentKVError(...) instanceof AgentXError` both hold, and so callers that
 * imported `AgentKVError` before this refactor keep compiling and matching.
 */
export { AgentXError as AgentKVError };

/** Thrown when a paying call would exceed a configured spend cap. */
export class SpendCapError extends AgentXError {
  constructor(message: string) {
    super(message, "spend_cap_exceeded");
    this.name = "SpendCapError";
  }
}
