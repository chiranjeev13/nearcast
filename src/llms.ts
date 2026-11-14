/**
 * Writes llms-full.txt: the whole language reference as one Markdown file, for LLMs and AI search.
 * Built from the same module docs as the docs pane and `nearcast docs`, so it never drifts.
 *   tsx src/llms.ts <out-file>
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDocs } from "./docs.js";
import type { EntryDoc } from "./ui/api.js";

const SITE = "https://nearcast-phi.vercel.app";
const REPO = "https://github.com/chiranjeev13/nearcast";

function entry(e: EntryDoc): string[] {
  const out = [`### \`${e.insert}\``, "", "```", e.usage, "```", "", e.summary];
  if (e.details) out.push("", e.details);
  if (e.opts?.length) {
    out.push("", "Options:");
    for (const o of e.opts) out.push(`- \`--${o.name}${o.value ? ` ${o.value}` : ""}\`: ${o.summary}`);
  }
  if (e.chains?.length) out.push("", `Chains: ${e.chains.join(", ")}`);
  if (e.example) out.push("", "Example:", "", "```", e.example, "```");
  return [...out, ""];
}

export function renderLlmsFull(): string {
  const d = buildDocs();
  const out: string[] = [
    "# Nearcast: full language reference",
    "",
    "> Nearcast is a scripting language for NEAR. A script says in a few readable lines what should happen onchain. Nearcast simulates every step against live chain state, shows exactly what will be signed, then runs it from the user's NEAR wallet and resumes from a checkpoint if anything fails. Through NEAR Chain Signatures and NEAR Intents, one NEAR account's script also acts on EVM chains, Bitcoin and Solana.",
    "",
    `App: ${SITE} (write, simulate and run scripts in the browser with a NEAR wallet). Source: ${REPO}`,
    "",
    "## Writing scripts: the essentials",
    "",
    "- One statement per line. `#` starts a comment.",
    "- `load <module>` before using a module's commands (`token:transfer`) or helpers (`@token:balance`). Built-ins (`transfer`, `call`, `batch`, `@balance` …) need no load.",
    "- `set $name <value>` stores a variable; `$name` reads it.",
    "- `@helper(args)` reads live state (balances, view calls, derived addresses). Helpers never sign anything.",
    "- `assert <left> <op> <right> \"message\"` stops the plan before anything is signed if the check fails. Operators: > >= < <= == !=",
    "- Blocks use parentheses: `batch ( … )` makes one atomic NEAR transaction; `chainsig:on <chain> \"<path>\" ( … )` holds EVM calls signed by the NEAR account.",
    "- Each command is one step. Steps run in order; steps on different chains are not atomic with each other.",
    "- NEAR amounts without a unit are whole NEAR (`transfer bob.near 0.1` sends 0.1 NEAR). Token amounts in `token:transfer` and `intents:swap` are whole tokens. Amounts inside `exec` and in balance comparisons are raw units, so write `1e6` for 1 USDC (6 decimals).",
    "- Strings use double quotes. Chain Signatures paths (\"payroll\", \"vault\") name independent addresses per chain, all controlled by the same NEAR account.",
    "",
    "## Units",
    "",
    ...d.units.map((u) => `- \`${u.suffix}\`: ${u.summary}`),
    "",
    "## Language keywords",
    "",
  ];
  for (const e of d.entries.filter((e) => e.kind === "keyword")) out.push(...entry(e));

  for (const m of d.modules) {
    const list = d.entries.filter((e) => e.module === m.name);
    if (!list.length) continue;
    out.push(`## Module \`${m.name}\`${m.builtin ? " (built in)" : ` (\`load ${m.name}\`)`}`, "", m.summary, "");
    const cmds = list.filter((e) => e.kind === "command");
    const helpers = list.filter((e) => e.kind === "helper");
    if (cmds.length) out.push("Commands:", "");
    for (const e of cmds) out.push(...entry(e));
    if (helpers.length) out.push("Helpers:", "");
    for (const e of helpers) out.push(...entry(e));
  }

  out.push("## Chains", "");
  for (const [network, chains] of Object.entries(d.chains)) {
    out.push(`### ${network}`, "");
    for (const c of chains) {
      out.push(`- \`${c.name}\`: ${c.label} (${c.kind}, native ${c.symbol}, ${c.decimals} decimals${c.tokens.length ? `, tokens: ${c.tokens.join(", ")}` : ""})`);
    }
    out.push("");
  }
  out.push("## NEAR tokens by symbol", "");
  for (const [network, tokens] of Object.entries(d.nearTokens)) out.push(`- ${network}: ${tokens.join(", ")}`);
  out.push("");

  out.push(
    "## Example scripts",
    "",
    "### Payroll on three chains from one NEAR account (testnet)",
    "",
    "```",
    "load chainsig",
    "",
    "assert @balance > 0.5near \"need 0.5 NEAR for signing fees\"",
    "assert @chainsig:balance(base \"payroll\" USDC) >= 1e6 \"Base payroll wallet needs 1 USDC\"",
    "assert @chainsig:balance(solana \"payroll\") > 0.02e9 \"Solana payroll wallet needs 0.02 SOL\"",
    "assert @chainsig:balance(bitcoin \"payroll\") > 5000 \"Bitcoin payroll wallet needs 5000 sats\"",
    "",
    "chainsig:on base \"payroll\" (",
    "  exec @token(USDC) \"transfer(address,uint256)\" 0xcC50098040cdD7F65f198f3EDF5baB02bC3dfa10 1e6",
    ")",
    "chainsig:transfer solana \"payroll\" 8xXETPXGab2fEyqhaeGeUkxxFXhGkC5wo8ndNzTikcZj 0.01",
    "chainsig:transfer bitcoin \"payroll\" tb1qsstasqk8t7qu0d9ywr7khf3nug2jyaszpkrl4d 0.00001",
    "```",
    "",
    "### Settle USDC from NEAR onto Base and Solana in one transaction (mainnet)",
    "",
    "```",
    "load intents",
    "load token",
    "",
    "assert @token:balance(USDC) >= 4e6 \"need 4 USDC on NEAR\"",
    "",
    "batch (",
    "  intents:swap 2 from near:USDC to base:USDC --to 0xYourBaseAddress",
    "  intents:swap 2 from near:USDC to solana:USDC --to YourSolanaAddress",
    ")",
    "```",
    "",
  );
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "examples");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".cast")).sort()) {
    out.push(`### examples/${f}`, "", "```", readFileSync(join(dir, f), "utf8").trimEnd(), "```", "");
  }

  out.push(
    "## How a run works",
    "",
    "1. Simulate: reads live balances, estimates gas, pins nonces, picks Bitcoin inputs, fetches Intents quotes. Signs nothing. Each step is tagged [READ-ONLY], [STATE-CHANGING], [IRREVERSIBLE] or [HIGH-VALUE].",
    "2. Execute: the NEAR wallet (Meteor, HOT, MyNearWallet, Intear, or MetaMask via NEAR's Ethereum wallet support) approves each transaction. Other chains are signed by NEAR's MPC network, and every signature is checked against the expected address before broadcast.",
    "3. Resume: every step is checkpointed; a run never sends a second transaction for a step that may already have landed.",
    "",
    "CLI: `nearcast plan script.cast` (simulate), `nearcast run script.cast`, `nearcast resume script.cast`, `nearcast docs [filter]`, `nearcast ui`. Flags: `--network testnet|mainnet`, `--account <id>`.",
    "",
    "## Limits",
    "",
    "- NEAR Intents runs on mainnet only.",
    "- Chain Signatures requests are one per transaction: `chainsig:on` and `chainsig:transfer` go outside `batch`.",
    "- Bitcoin: one payment per address per script. Solana: native SOL only (no SPL tokens yet).",
    "- Wallets can't sign meta transactions or global-contract actions; use a local key with the CLI.",
    "- MetaMask (as a NEAR wallet) splits multi-action transactions, so it can't approve a `batch`.",
    "",
  );
  return out.join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = process.argv[2];
  if (!file) throw new Error("usage: tsx src/llms.ts <out-file>");
  writeFileSync(file, renderLlmsFull());
}
