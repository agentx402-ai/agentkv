import { toWholeAtomicUsd } from "@agentkv/client";
import { parseFlags } from "../args";
import { EXIT, printError, printJson, type Writer } from "../output";

/** The validated result of parseDepositArgs: either the amount, or a usage-error message. */
export type ParsedDeposit = { ok: true; usd: number } | { ok: false; message: string };

/**
 * Parse and validate `deposit`'s own <usd> argument — no client, no network. See parseKvArgs's
 * doc comment (commands/kv.ts) for why this split exists: cli.ts runs it before
 * clientFromConfig, which mints a wallet on first use. Unlike parseKvArgs's `set` case, this is
 * pure arithmetic on a positional with no I/O, so it's safe to call twice — runCredits below
 * calls it again itself, the same way the sibling agentrag repo's parseXxxArgs functions do.
 */
export function parseDepositArgs(args: string[]): ParsedDeposit {
  const { positionals } = parseFlags(args);
  const usd = Number(positionals[0]);
  // Same acceptance rule as client deposit() — the client's relative-epsilon converter,
  // not exact float equality (33.3*1e6 !== Math.round(33.3*1e6) in IEEE-754, so the old
  // check rejected whole-atomic amounts the client accepts).
  if (!Number.isFinite(usd) || usd < 1 || toWholeAtomicUsd(usd) === null) {
    return {
      ok: false,
      message: "deposit requires <usd> >= 1 (a whole number of atomic USDC units)",
    };
  }
  return { ok: true, usd };
}

export async function runCredits(
  cmd: string,
  args: string[],
  io: { client: any; stdout: Writer; stderr: Writer },
): Promise<number> {
  if (cmd === "balance") {
    printJson(io.stdout, { balance: await io.client.balance() });
    return EXIT.OK;
  }
  // Fails with USAGE before a round-trip.
  const parsed = parseDepositArgs(args);
  if (!parsed.ok) {
    printError(io.stderr, "usage", parsed.message);
    return EXIT.USAGE;
  }
  printJson(io.stdout, await io.client.deposit(parsed.usd));
  return EXIT.OK;
}
