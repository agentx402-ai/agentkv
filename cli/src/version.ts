// cli/src/version.ts
/**
 * Single source of truth for the @agentkv/cli version — used by `agentkv --version`
 * and the MCP server handshake. Keep in sync with cli/package.json on release
 * (see RELEASING.md); the version-sync check in CI guards against drift.
 */
export const VERSION = "0.2.1";
