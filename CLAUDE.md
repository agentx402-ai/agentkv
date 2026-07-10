# CLAUDE.md

The shared agent/contributor guide lives in **AGENTS.md** (cross-tool standard) —
commands, conventions, money-safety invariants, release process. Read it first:

@AGENTS.md

Claude Code specifics:

- After changing code, the gate is `npm run lint && npm test` (Biome + both
  workspace suites; `npm test` builds the client first).
- The payment-gating regressions in `client/test/account-topoff.test.ts` are
  deliberately white-box (setter traps) — a failing one means your change reopened
  a real spend-safety hole; fix the code, not the test.
- MCP server lives behind `agentkv mcp` (`cli/`); its tool annotations
  (read-only vs state-changing) must stay truthful — clients use them to decide
  when to prompt a human before spending.
