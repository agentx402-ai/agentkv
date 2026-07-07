# Security Policy

The AgentKV clients handle private keys, client-side encryption, and real USDC payments, so we
take security reports seriously.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately via either:

- GitHub's [private vulnerability reporting](https://github.com/agentx402-ai/agentkv/security/advisories/new)
  (preferred), or
- email **contact@agentx402.ai** with a subject starting `SECURITY:`.

Please include a description, the affected package(s) and version(s), reproduction steps, and the
impact. We aim to acknowledge within 72 hours and will keep you updated through remediation. Please
give us a reasonable window to ship a fix before any public disclosure.

## Scope

This repository contains the **client** surface — `@agentkv/client` (SDK), `@agentkv/cli` (CLI +
MCP server), and the Claude plugin. The hosted AgentKV worker backend is operated separately and is
out of scope here. In scope: the client's cryptography, signing, payment-authorization handling,
key management, and dependency vulnerabilities.

## Threat model — what "zero-knowledge" covers

Values are AES-256-GCM encrypted **client-side** before they reach the server, so the hosted worker
only ever stores ciphertext it cannot read. That protects values against the **server operator** —
not against the party operating the client:

- **SDK / CLI-direct:** the value stays in your own process; it is never sent to any model.
- **MCP server / Claude plugin:** a plain `agentkv_set` value is a model-generated tool argument and
  a plain `agentkv_get` returns the decrypted value into the model's tool result — so the
  **plaintext passes through the operating agent's model context**. Encryption protects only the
  client↔server hop, not the agent.

**Key names are hidden too, not just values.** The server is addressed by an opaque **per-wallet
digest** (a keyed hash — blind index — of the name), and each key's name is stored **encrypted**, so
the worker only ever sees digests and ciphertext, never a plaintext key name; `list-keys` returns the
encrypted names for the client to decrypt locally. What the server **can** still observe is the
**number** of keys you store and the **access pattern** (which key is read or written, and when) —
hiding those would require ORAM and is out of scope. So "zero-knowledge" here means your key **names
and values** are private to you, **not** your access patterns or key count.

For credentials that must never enter a model turn, use the **secret-safe** tools — `set_from_env` /
`set_from_file` to store and `get_to_file` / `run_with_secret` to use — which read/write the secret
through a local file or child-process env and return only a path or command output, never the value.
The wallet private key is never exposed to the model on any path: it stays in the MCP subprocess env
/ OS keychain, is **scrubbed from the server's own env once the client captures it**, and the
secret-source tools **refuse to read protected key material** (`AGENTKV_PRIVATE_KEY` /
`AGENTKV_ENCRYPTION_KEY` / `AGENTKV_ACCOUNT_KEY`) or pseudo-filesystem paths (`/proc`, `/sys`).

**The account-key bearer is a full-ownership secret.** In the opt-in account-key mode, the raw
`ak_…` bearer token (`AGENTKV_ACCOUNT_KEY`) *is* the account identity — presenting it confers full
namespace ownership: the holder can read/write any key, whether that op is paid from the account's
prepaid credits or settled **inline** with the holder's own funds (no credits required). Treat it with the same
care as `AGENTKV_PRIVATE_KEY`: keep it (and its paired `AGENTKV_ENCRYPTION_KEY`) in env / a secret
manager, never a config file or source control. The server stores only a hash of the bearer, so a
lost token is unrecoverable — back it up on mint.

**Residual risks of the secret-safe tools (local, not model-facing).** These tools materialize the
plaintext locally so it can be *used*, with local-observer tradeoffs to be aware of:

- `agentkv_run_with_secret` puts the secret in the **child process's environment**, visible to
  same-UID and root observers (`/proc/<pid>/environ`, `ps e`) for the child's lifetime — prefer
  short-lived commands. The **wallet key (`AGENTKV_PRIVATE_KEY`) and any encryption key are stripped
  from the child's _inherited_ environment**, so they are not handed to the command directly. This is
  least-privilege, not an isolation boundary: a same-UID command could still read the MCP server's
  own environment via `/proc/<ppid>/environ` or `ps eww` — the same baseline access the operating
  agent's shell already has.
  Process-hijack env vars (`LD_PRELOAD`, `NODE_OPTIONS`, `PATH`, `*_PROXY`, …) are rejected for both the
  injected var and `extra_env` so the secret can't be redirected into attacker code, and a child is
  hard-killed (SIGKILL) at the timeout.
- `agentkv_get_to_file` refuses to follow or overwrite a pre-existing path/symlink and returns only
  the path — **delete the file when done**. With no `path`, the file lives in a fresh `mkdtemp` dir
  (`0700` POSIX / per-user ACL on Windows). With an explicit `path`, it is `chmod 0600` on POSIX;
  **on Windows an explicit path inherits the parent directory's ACL** (Node cannot set a
  0600-equivalent), so omit `path` for a guaranteed-private file.
- `set_from_file` / `get_to_file` read/write **arbitrary local paths** at the CLI's privilege. The
  operating agent already has filesystem access (its own shell), so this grants nothing beyond that
  baseline — but treat the secret tools as having full local read/write.
- `run_with_secret` and `get_to_file` perform a **paid read each call**. Bound spend with
  `AGENTKV_MAX_SPEND_USD` (per-operation cap) and/or `AGENTKV_MAX_SESSION_SPEND_USD` (cumulative
  cap across the client's lifetime); both are optional and a malformed value fails closed. They are
  independent knobs — the per-op cap is not silently reused as a session budget.

## Account-key auto top-off (subprocess surface)

`AGENTKV_TOPOFF=awal` makes the CLI spawn `npx -y awal@2.12.0 x402 pay` (the version pinned as
`AWAL_SPEC` in `cli/src/awal.ts`, bumped in lockstep with the skill docs) to fund
`/account/deposit`. Containment properties, as implemented in `cli/src/awal.ts`:

- **No shell.** The subprocess is spawned via Node's `execFile` with an argv array (`npx`, plus
  the fixed flags); nothing is string-interpolated into a shell, so there is no injection surface
  through the deposit URL, bearer, or amount.
- **Validated inputs, checked before spawn.** The bearer must match `^ak_[0-9a-f]{64}$`; the
  deposit URL must parse and be `http:`/`https:` with a pathname of exactly `/account/deposit`
  (the URL itself is always the client's own configured endpoint — the SDK constructs it
  internally and never accepts a caller-supplied deposit URL); and `maxAmountAtomic` must be a
  positive integer. Any failed check throws before `execFile` ever runs.
- **Bounded spend.** `--max-amount` is always passed, set to exactly the configured top-off
  (`prepay.topoff`, in atomic USDC units); the SDK (`client/src/index.ts`) holds a single-flight
  guard so at most one top-off is in flight at a time, and a hard-402 (insufficient credits)
  retries the failing op at most once, after at most one top-off. Top-offs are recorded against
  `AGENTKV_MAX_SESSION_SPEND_USD` only, never the per-operation `AGENTKV_MAX_SPEND_USD` cap.
- **Bearer hygiene.** The `ak_…` token travels only inside the subprocess argv (an `-h` header
  arg) — it is never written to a log. If the subprocess itself fails (`execFile`'s error embeds
  the full argv, bearer included) or awal's own `--json` output reports an error, the token is
  redacted (`ak_…`) from the resulting error message before it propagates; a rejected `topoffPayer`
  call surfaces to the SDK as `account_topoff_failed`, and neither the accountKey nor the URL
  appears in the pre-spawn validation error messages.

## Account-key inline pay (subprocess surface)

`AGENTKV_INLINE=awal` wires the SDK's `opInlinePayer` hook to route a whole account-key
`set()`/`get()` op through `npx -y awal@2.12.0 x402 pay` (same `AWAL_SPEC`-pinned version as the
top-off above, `cli/src/awalInline.ts`) as an alternative to auto top-off (they are mutually
exclusive per op — if both are configured, top-off takes precedence and inline pay never fires) —
this settles that op's price on-chain per-request rather than debiting prepaid credits. Containment mirrors
`cli/src/awal.ts`:

- **No shell.** Spawned via `execFile` with an argv array; the URL, bearer, body, and amount are
  never string-interpolated into a shell.
- **Validated inputs, checked before spawn.** The `Authorization` header must match
  `Bearer ak_[0-9a-f]{64}`; the URL must be `http:`/`https:` with a pathname under `/kv/` (refuses
  to pay any other route); `maxAmountAtomic` must be a positive integer; and the method must be
  `POST` or `GET`. Any failed check throws before `execFile` ever runs.
- **Bounded spend.** `--max-amount` is always passed as the op's own price (`maxAmountAtomic`), so
  a single inline-paid op cannot settle for more than it quoted.
- **Bearer hygiene.** The bearer travels only inside the subprocess argv (a JSON-stringified `-h`
  headers arg) — it is never logged. Both a subprocess failure (`execFile`'s error embeds the full
  argv) and any error awal itself reports are redacted (`ak_…`) before propagating to the SDK.
- **Fixed timeout.** The subprocess is bounded to 120s (`windowsHide` on Windows).

## Known advisories

`npm audit` may report a high-severity advisory for **`ws`** (GHSA-96hv-2xvq-fx4p), pulled in
transitively through `viem`. AgentKV's client uses `viem` **only for signing and address/hash
utilities** and never opens a WebSocket transport, so the affected code path is not reachable from
this SDK. This repository pins a patched `ws` via an `overrides` entry; downstream consumers resolve
`ws` through their own dependency tree, so keep `viem`/`ws` up to date (Dependabot is enabled here).

## Supported versions

The latest released minor of each `@agentkv/*` package receives security fixes.
