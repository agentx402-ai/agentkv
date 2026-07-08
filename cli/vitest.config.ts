import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // vi.restoreAllMocks() does NOT undo vi.stubGlobal() — without this, a test that stubs
    // global fetch leaks the stub into every later test in the file (order-dependent, and a
    // future test reaching the network would be silently answered by the stale stub). Auto-
    // restore stubbed globals between tests so each starts with the real fetch.
    unstubGlobals: true,
    server: {
      deps: {
        // Inline @agentkv/client so its classes share one module instance
        // with src/cli.ts — needed for `instanceof` checks in mapError tests.
        inline: ["@agentkv/client"],
      },
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "text-summary"],
    },
  },
});
