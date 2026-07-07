import { existsSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { clientFromConfig, readConfigFile, resolveConfig } from "./config.js";
import { peekStoredAccount } from "./keystore.js";
import { getOnrampProvider } from "./onramp.js";
import {
  forbiddenEnvKey,
  readEnvSecret,
  readFileSecret,
  runWithSecret,
  scrubSensitiveEnv,
  writeSecretFile,
} from "./secrets.js";

// Structured tool-error envelope, shared by every secret tool so the {error,code}
// shape stays consistent — callers/models key on `code`.
const toolError = (error: string, code: string) => ({
  isError: true as const,
  content: [{ type: "text" as const, text: JSON.stringify({ error, code }) }],
});

export function buildMcpServer(
  client: {
    set: (
      key: string,
      value: unknown,
      opts?: { ttl_days?: number; strict_ttl?: boolean; idempotencyKey?: string },
    ) => Promise<unknown>;
    get: (key: string, opts?: { idempotencyKey?: string }) => Promise<unknown>;
    delete: (key: string) => Promise<unknown>;
    deposit: (amountUsd: number) => Promise<unknown>;
    balance: () => Promise<number>;
    listKeys: (opts?: {
      cursor?: string | null;
      limit?: number;
    }) => Promise<{ keys: string[]; cursor: string | null }>;
    address: string;
    /** Deployment base URL — used to point the account-mode funding message at the right server. */
    endpoint: string;
  },
  // Onramp config for the (read-only) agentkv_fund tool. Optional so callers/tests that
  // don't need funding can omit it; when absent, the tool reports the destination address
  // and how to configure the onramp instead of failing.
  onramp?: {
    provider: string;
    network: string;
    config: Record<string, string | undefined>;
  },
  // Account-key mode has NO wallet address — client.address is the zero-address SENTINEL.
  // When true, agentkv_fund REFUSES (a card purchase to the sentinel would burn real USDC)
  // and agentkv_wallet_address reports account-key mode instead of the misleading sentinel.
  accountMode = false,
): McpServer {
  const server = new McpServer({ name: "agentkv", version: "0.1.0" });

  server.tool(
    "agentkv_set",
    "Store an encrypted value under a key (costs $0.005 USD per write, or 5 credits ≈ $0.0005 via prepay). NOTE: the value passes through this agent's model context — do NOT use for secrets; use agentkv_set_from_env or agentkv_set_from_file instead.",
    {
      key: z.string().describe("The key to store the value under"),
      // .refine(v !== undefined) marks `value` REQUIRED in the advertised JSON schema. A bare
      // z.unknown() is optional (isOptional() === true), so the schema omitted `value` from
      // `required` and the SDK accepted {key} — then client.set(key, undefined) threw a
      // confusing runtime invalid_value instead of a protocol-level InvalidParams rejection.
      value: z
        .unknown()
        .refine((v) => v !== undefined, { message: "value is required" })
        .describe("The value to encrypt and store"),
      ttl_days: z.number().optional().describe("Time-to-live in days"),
      strict_ttl: z.boolean().optional().describe("If true, reads do not slide the expiry"),
      idempotency_key: z
        .string()
        .optional()
        .describe(
          "Stable key making a retried write exactly-once — reuse the same value across retries so the server dedupes instead of double-charging",
        ),
    },
    {
      title: "Set value",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async (args) => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            await client.set(args.key, args.value, {
              ttl_days: args.ttl_days,
              strict_ttl: args.strict_ttl,
              idempotencyKey: args.idempotency_key,
            }),
          ),
        },
      ],
    }),
  );

  server.tool(
    "agentkv_get",
    "Read and decrypt a value by key (costs $0.003 USD per read, or 3 credits ≈ $0.0003 via prepay); returns null if absent. NOTE: the decrypted value is returned into this agent's model context — do NOT use for secrets; use agentkv_get_to_file or agentkv_run_with_secret instead.",
    {
      key: z.string().describe("The key to retrieve"),
      idempotency_key: z
        .string()
        .optional()
        .describe(
          "Stable key making a retried read exactly-once — reuse the same value across retries so the server dedupes instead of double-charging",
        ),
    },
    { title: "Get value", readOnlyHint: true, openWorldHint: true },
    async (args) => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            await client.get(
              args.key,
              args.idempotency_key ? { idempotencyKey: args.idempotency_key } : {},
            ),
          ),
        },
      ],
    }),
  );

  server.tool(
    "agentkv_delete",
    "Delete a key (free operation)",
    { key: z.string().describe("The key to delete") },
    {
      title: "Delete key",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    async (args) => ({
      content: [{ type: "text" as const, text: JSON.stringify(await client.delete(args.key)) }],
    }),
  );

  server.tool(
    "agentkv_deposit",
    "Buy credits with USDC (any amount ≥ $1; credits are 1/10 the pay-per-op price). Real payment — $amount_usd is charged from the wallet.",
    { amount_usd: z.number().describe("Amount in USD to deposit as credits") },
    {
      title: "Deposit credits",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async (args) => {
      // Account-key mode has NO signing wallet, so client.deposit() always throws no_signer.
      // Gate it (like agentkv_fund) with a clear structured error instead of forwarding to a
      // raw throw: account credits are added by depositing to <endpoint>/account/deposit from
      // a signing wallet, not via this tool.
      if (accountMode) {
        return toolError(
          "Account-key mode has no signing wallet to pay from. Account credits are added by " +
            `depositing USDC to ${client.endpoint}/account/deposit from a wallet that can sign ` +
            "(e.g. awal), not via this tool.",
          "account_mode",
        );
      }
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(await client.deposit(args.amount_usd)) },
        ],
      };
    },
  );

  server.tool(
    "agentkv_balance",
    "Read the current credit balance (free)",
    {},
    { title: "Read balance", readOnlyHint: true, openWorldHint: true },
    async () => ({
      content: [
        { type: "text" as const, text: JSON.stringify({ balance: await client.balance() }) },
      ],
    }),
  );

  server.tool(
    "agentkv_wallet_address",
    "Return this agent's wallet address (its namespace in AgentKV)",
    {},
    { title: "Wallet address", readOnlyHint: true, openWorldHint: false },
    async () => ({
      content: [
        {
          type: "text" as const,
          // Account-key mode has no wallet; client.address is the zero-address sentinel, so
          // returning it verbatim would misrepresent identity. Report account-key mode instead.
          text: JSON.stringify(
            accountMode
              ? {
                  mode: "account-key",
                  address: null,
                  note: "account-key mode has no wallet address; the account is identified by its bearer key",
                }
              : { address: client.address },
          ),
        },
      ],
    }),
  );

  server.tool(
    "agentkv_fund",
    "Return a card→USDC onramp URL that delivers USDC to this agent's wallet (its namespace). Read-only — builds a URL, no payment is made. Open the URL to buy USDC and have it sent to the wallet on Base; then use agentkv_deposit to convert USDC to credits.",
    {
      amount_usd: z
        .number()
        .optional()
        .describe("Optional preset fiat (USD) amount to pre-fill in the onramp"),
    },
    { title: "Fund via onramp", readOnlyHint: true, openWorldHint: true },
    async (args) => {
      // Account-key mode has no single wallet to onramp into — client.address is the
      // zero-address sentinel, so a completed card purchase would send real USDC to the
      // burn address, permanently lost. Refuse and explain how account credits are funded
      // (mirrors the CLI's runFund). This check MUST come first (before onramp/config).
      if (accountMode) {
        return toolError(
          "Account-key mode has no single wallet to onramp into. Account credits are funded by " +
            `depositing USDC to ${client.endpoint}/account/deposit from a wallet that can sign (e.g. awal). ` +
            "An onramp can fund such a signing wallet: fund a wallet first (e.g. send USDC to it, " +
            "`awal address`, or set AGENTKV_PRIVATE_KEY and re-run the funding flow), then deposit to the account.",
          "account_mode",
        );
      }
      if (!onramp) {
        return toolError(
          "onramp is not configured for this server (no provider/config available)",
          "onramp_unavailable",
        );
      }
      let provider: ReturnType<typeof getOnrampProvider>;
      try {
        provider = getOnrampProvider(onramp.provider);
      } catch (e) {
        return toolError(e instanceof Error ? e.message : String(e), "unknown_provider");
      }
      let url: string;
      try {
        url = provider.buildUrl({
          address: client.address as `0x${string}`,
          network: onramp.network,
          amountUsd: args.amount_usd,
          config: onramp.config,
        });
      } catch (e) {
        return toolError(e instanceof Error ? e.message : String(e), "onramp_config");
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ provider: provider.id, url, address: client.address }),
          },
        ],
      };
    },
  );

  server.tool(
    "agentkv_list_keys",
    "List this wallet's stored keys — the real key NAMES, decrypted locally. The server only ever sees opaque per-wallet digests + ciphertext, never plaintext key names. Free (identity-signed). Paginated: pass the returned cursor to fetch the next page.",
    {
      cursor: z.string().optional().describe("Opaque pagination cursor from a previous call"),
      limit: z.number().optional().describe("Max keys per page"),
    },
    { title: "List keys", readOnlyHint: true, openWorldHint: true },
    async (args) => {
      const res = await client.listKeys({ cursor: args.cursor ?? null, limit: args.limit });
      return { content: [{ type: "text" as const, text: JSON.stringify(res) }] };
    },
  );

  // --- LLM-free secret tools: the plaintext value never enters the model context ---

  server.tool(
    "agentkv_set_from_env",
    "Store a secret read from a LOCAL environment variable, without the value entering this agent's model context. Pass the env var NAME (not its value); the server reads it locally, encrypts, and stores it. Use this (not agentkv_set) for credentials.",
    {
      key: z.string().describe("The key to store under"),
      env_var: z
        .string()
        .describe(
          "Name of the local environment variable whose value to store (never sent to the model)",
        ),
      ttl_days: z.number().optional().describe("Time-to-live in days"),
      strict_ttl: z.boolean().optional().describe("If true, reads do not slide the expiry"),
      idempotency_key: z.string().optional().describe("Stable key for exactly-once retried writes"),
    },
    {
      title: "Set from env var",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async (args) => {
      const r = readEnvSecret(args.env_var);
      if (!r.ok) return toolError(r.error, r.code);
      const res = await client.set(args.key, r.value, {
        ttl_days: args.ttl_days,
        strict_ttl: args.strict_ttl,
        idempotencyKey: args.idempotency_key,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(res) }] };
    },
  );

  server.tool(
    "agentkv_set_from_file",
    "Store a secret read from a LOCAL file, without the contents entering this agent's model context. Pass the file PATH; the server reads it locally (as UTF-8 text, trimming one trailing newline unless trim:false — not for binary key material), encrypts, and stores it. Use this (not agentkv_set) for credentials.",
    {
      key: z.string().describe("The key to store under"),
      path: z.string().describe("Local file path to read (contents never sent to the model)"),
      trim: z.boolean().optional().describe("Trim a single trailing newline (default true)"),
      ttl_days: z.number().optional().describe("Time-to-live in days"),
      strict_ttl: z.boolean().optional().describe("If true, reads do not slide the expiry"),
      idempotency_key: z.string().optional().describe("Stable key for exactly-once retried writes"),
    },
    {
      title: "Set from file",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async (args) => {
      const r = readFileSecret(args.path, { trim: args.trim });
      if (!r.ok) return toolError(r.error, r.code);
      const res = await client.set(args.key, r.value, {
        ttl_days: args.ttl_days,
        strict_ttl: args.strict_ttl,
        idempotencyKey: args.idempotency_key,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(res) }] };
    },
  );

  server.tool(
    "agentkv_get_to_file",
    "Read a secret and write the decrypted value to a LOCAL FILE, without the value entering this agent's model context. Returns { found, path, bytes } — the file path and byte count, never the value. Performs a paid read each call. The destination must NOT already exist (a fresh path is created — this prevents overwriting or symlink redirection); omit `path` for a private temp file. Use this (not agentkv_get) for credentials, then delete the file when done.",
    {
      key: z.string().describe("The key to read"),
      path: z
        .string()
        .optional()
        .describe("Destination file path; if omitted, a private temp file is created"),
      idempotency_key: z.string().optional().describe("Stable key for exactly-once retried reads"),
    },
    {
      title: "Get to file",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async (args) => {
      // Cheap best-effort precheck BEFORE the paid read: if an explicit destination already
      // exists, refuse now rather than charging for a read whose value we'd then discard on the
      // O_EXCL open. (The O_EXCL open remains the authoritative TOCTOU guard below.)
      if (args.path && existsSync(args.path)) {
        return toolError(
          "destination already exists; choose a fresh path that does not already exist",
          "dest_exists",
        );
      }
      const v = await client.get(
        args.key,
        args.idempotency_key ? { idempotencyKey: args.idempotency_key } : {},
      );
      if (v === null || v === undefined) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ found: false }) }] };
      }
      const text = typeof v === "string" ? v : JSON.stringify(v);
      let written: { path: string; bytes: number };
      try {
        written = writeSecretFile(text, args.path);
      } catch (e) {
        // Distinct codes/messages so retry guidance is accurate (the old catch-all wrongly told
        // the agent to "choose a fresh path" for ENOENT/EACCES, causing endless paid retries).
        const code = (e as NodeJS.ErrnoException)?.code;
        if (code === "EEXIST")
          return toolError("destination already exists; choose a fresh path", "dest_exists");
        if (code === "ENOENT")
          return toolError("destination parent directory does not exist", "dest_parent_missing");
        if (code === "EACCES" || code === "EPERM")
          return toolError("destination is not writable", "dest_unwritable");
        return toolError("could not write file", "write_failed");
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ found: true, path: written.path, bytes: written.bytes }),
          },
        ],
      };
    },
  );

  server.tool(
    "agentkv_run_with_secret",
    "Run a command with a stored secret injected into the child process's environment ONLY, without the value entering this agent's model context. Pass the env var NAME + command + args; the server decrypts the secret, sets it in the child env, runs the command, and returns its exit code + output (not the secret). Performs a paid read each call. The command must not echo the secret. Use this to USE a credential without the model ever seeing it.",
    {
      key: z.string().describe("The key holding the secret"),
      env_var: z.string().describe("Env var name to expose the secret as in the child process"),
      command: z.string().describe("Executable to run (no shell; pass a real executable)"),
      args: z
        .array(z.string())
        .optional()
        .describe("Arguments passed as argv (no shell expansion)"),
      cwd: z.string().optional().describe("Working directory"),
      timeout_ms: z
        .number()
        .optional()
        .describe(
          "Kill the command after this many ms (default 120000; values ≤0 use the default)",
        ),
      extra_env: z
        .record(z.string())
        .optional()
        .describe("Additional NON-secret env vars to set for the child process"),
      idempotency_key: z.string().optional().describe("Stable key for exactly-once retried reads"),
    },
    {
      title: "Run with secret",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async (args) => {
      const badEnv = forbiddenEnvKey([args.env_var, ...Object.keys(args.extra_env ?? {})]);
      if (badEnv) return toolError(`refusing process-hijack env var: ${badEnv}`, "forbidden_env");
      const v = await client.get(
        args.key,
        args.idempotency_key ? { idempotencyKey: args.idempotency_key } : {},
      );
      if (v === null || v === undefined) return toolError(`key ${args.key} not found`, "not_found");
      const secret = typeof v === "string" ? v : JSON.stringify(v);
      let result: Awaited<ReturnType<typeof runWithSecret>>;
      try {
        result = await runWithSecret({
          secret,
          envVar: args.env_var,
          command: args.command,
          args: args.args,
          cwd: args.cwd,
          timeoutMs: args.timeout_ms,
          extraEnv: args.extra_env,
        });
      } catch (e) {
        // spawn-time failure (ENOENT for a bad command, EACCES on cwd, …) — return the
        // structured envelope instead of letting the raw error become an SDK string.
        return toolError(e instanceof Error ? e.message : String(e), "spawn_failed");
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    },
  );

  return server;
}

export async function startMcp(
  deps: { env?: NodeJS.ProcessEnv; client?: Parameters<typeof buildMcpServer>[0] } = {},
): Promise<void> {
  const env = deps.env ?? process.env;
  const cfg = resolveConfig({}, env, () => readConfigFile(env));
  const client =
    deps.client ??
    clientFromConfig(cfg, {
      env,
      // CRITICAL: notice to stderr only — stdout is the MCP JSON-RPC channel.
      notify: (m) => process.stderr.write(`agentkv: ${m}\n`),
    });
  // Detect account-key mode the same way clientFromConfig selects it: an explicit
  // AGENTKV_ACCOUNT_KEY env wins outright; else a stored account.json file when no
  // AGENTKV_PRIVATE_KEY env is set. In account mode there is no wallet to fund/onramp
  // into, so the MCP layer must refuse agentkv_fund (never emit a burn-address URL) and
  // report account-key mode from agentkv_wallet_address. Read BEFORE scrubbing env.
  const accountMode =
    cfg.accountKey != null || (cfg.privateKey == null && peekStoredAccount(env) != null);
  // Drop the wallet/encryption key from the server's own env once the client has
  // captured them, so set_from_env / a /proc read can't surface them to the model.
  // (Defense-in-depth — readEnvSecret/readFileSecret refuse these directly too.)
  scrubSensitiveEnv(env);
  const server = buildMcpServer(
    client,
    {
      provider: cfg.onrampProvider ?? "coinbase",
      network: cfg.network,
      config: cfg.onrampConfig ?? {},
    },
    accountMode,
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Keep the process alive until the MCP session genuinely closes.
  // Authoritative signal: the SDK server's own onclose hook (public on Protocol,
  // not clobbered by connect() — only transport.onclose is set internally).
  // Belt-and-suspenders: stdin EOF as a fallback. Promise.resolve is idempotent
  // so both signals firing is harmless.
  await new Promise<void>((resolve) => {
    server.server.onclose = resolve;
    process.stdin.once("close", resolve);
    process.stdin.once("end", resolve);
  });
}
