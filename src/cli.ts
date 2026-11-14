#!/usr/bin/env node
import { existsSync, readFileSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { checkpointPath, fileStore, inFlight, isComplete, newCheckpoint } from "./exec/checkpoint.js";
import { execute, type ExecOptions } from "./exec/executor.js";
import { ScriptError } from "./lang/ast.js";
import { renderDocs } from "./docs.js";
import { liveEnv } from "./live.js";
import { fileKeyRing } from "./near/keys.js";
import { plan, scriptHash } from "./plan/planner.js";
import type { Checkpoint, StepStatus } from "./plan/types.js";
import { planProblems, renderPlan, renderReceipt } from "./render.js";
import { startUi } from "./ui/server.js";

const USAGE = `nearcast: readable, resumable cross-chain scripts for one NEAR account

  nearcast plan   <script>    show what the script would do; signs and sends nothing
  nearcast run    <script>    show the plan, ask for confirmation, then execute
  nearcast resume <script>    continue an interrupted run from its checkpoint
  nearcast status <script>    show the receipt of the last run
  nearcast ui [script]        open the local web UI (editor, docs, simulate, run, wallet)
  nearcast docs [filter]      list every command and helper

Options
  --account <id>      NEAR account (default: NEAR_ACCOUNT_ID)
  --network <name>    NEAR network (default: testnet)
  --yes               skip the confirmation prompt
  --fresh             run: start over even though a finished run exists
  --retry-failed      resume: retry a failed NEAR transaction
  --kill-at <n>:<status>   exit abruptly right after step n reaches signed|broadcast|confirmed (for demos)
  --state-dir <dir>   where checkpoints live (default: .nearcast)
  --port <n>          ui: port to listen on, localhost only (default: 4040)

Keys: NEAR_PRIVATE_KEY, or ~/.near-credentials/<network>/<account>.json. A full-access key is
required to run; plan works with just an account id. Mainnet asks you to type "send on mainnet".`;

interface Args {
  cmd: string;
  file: string;
  account?: string;
  network: string;
  yes: boolean;
  fresh: boolean;
  retryFailed: boolean;
  killAt?: { step: number; status: StepStatus };
  stateDir: string;
  port: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { cmd: "", file: "", network: process.env.NEAR_NETWORK ?? "testnet", yes: false, fresh: false, retryFailed: false, stateDir: ".nearcast", port: 4040 };
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${x} needs a value`);
      return v;
    };
    if (x === "--account") a.account = val();
    else if (x === "--network") a.network = val();
    else if (x === "--state-dir") a.stateDir = val();
    else if (x === "--port") a.port = Number(val());
    else if (x === "--yes" || x === "-y") a.yes = true;
    else if (x === "--fresh") a.fresh = true;
    else if (x === "--retry-failed") a.retryFailed = true;
    else if (x === "--kill-at") {
      const m = /^(\d+):(signed|broadcast|confirmed)$/.exec(val());
      if (!m) throw new Error("--kill-at expects <step>:<signed|broadcast|confirmed>, e.g. 1:confirmed");
      a.killAt = { step: Number(m[1]), status: m[2] as StepStatus };
    } else if (x.startsWith("-")) throw new Error(`unknown option ${x}`);
    else pos.push(x);
  }
  [a.cmd, a.file] = pos;
  return a;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  const args = parseArgs(argv);
  if (args.cmd === "docs") {
    console.log(renderDocs(args.file));
    return 0;
  }
  if (args.cmd === "ui") {
    if (args.file && !existsSync(args.file)) throw new Error(`no such script: ${args.file}`);
    const rings = new Map<string, ReturnType<typeof fileKeyRing>>();
    const ring = (n: string) => {
      let r = rings.get(n);
      if (!r) rings.set(n, (r = fileKeyRing(n)));
      return r;
    };
    const baseDir = args.file ? dirname(resolve(args.file)) : process.cwd();
    const defaultAccount = args.account ?? process.env.NEAR_ACCOUNT_ID ?? ring(args.network).accounts()[0];
    const url = await startUi({
      makeEnv(network, account, signer) {
        const keys = ring(network);
        // Wallet mode: the wallet account never signs with a local key, even if one exists.
        const scoped = signer === "wallet" ? { ...keys, has: (id: string) => id !== account && keys.has(id) } : keys;
        return liveEnv({ network, accountId: account, keys: scoped, baseDir });
      },
      keyAccounts: (n) => ring(n).accounts(),
      defaultNetwork: args.network,
      defaultAccount,
      stateDir: args.stateDir,
      port: args.port,
      initialScript: args.file ? readFileSync(args.file, "utf8") : undefined,
      examplesDir: join(dirname(fileURLToPath(import.meta.url)), "..", "examples"),
    });
    console.log(`Nearcast UI: ${url}`);
    console.log(`Key accounts on ${args.network}: ${ring(args.network).accounts().join(", ") || "(none; connect a wallet)"}`);
    console.log("Local only. It can sign with local keys, so do not expose the port. Ctrl-C to stop.");
    return new Promise<number>(() => {});
  }
  if (!["plan", "run", "resume", "status"].includes(args.cmd) || !args.file) {
    console.error(USAGE);
    return 64;
  }
  if (!existsSync(args.file)) throw new Error(`no such script: ${args.file}`);
  const source = readFileSync(args.file, "utf8");
  const keys = fileKeyRing(args.network);
  const accountId = args.account ?? process.env.NEAR_ACCOUNT_ID;
  if (!accountId) throw new Error("No NEAR account: pass --account <id> or set NEAR_ACCOUNT_ID");
  if (args.cmd !== "plan" && args.cmd !== "status" && !keys.has(accountId)) {
    throw new Error(`No key for ${accountId}: set NEAR_PRIVATE_KEY or create ~/.near-credentials/${args.network}/${accountId}.json (use the web UI to sign with a wallet)`);
  }
  const env = liveEnv({ network: args.network, accountId, keys, baseDir: dirname(resolve(args.file)) });
  const path = checkpointPath(resolve(args.stateDir), args.network, accountId, scriptHash(source));
  const store = fileStore(path);
  const existing = store.load();

  const execOpts: ExecOptions = {
    log: (m) => console.log(`  ${m}`),
    retryFailed: args.retryFailed,
    afterPersist: (step, status) => {
      if (args.killAt && step.index + 1 === args.killAt.step && status === args.killAt.status) {
        console.log(`\n--kill-at ${args.killAt.step}:${status}: exiting abruptly, as if the process had been killed.`);
        process.exit(137);
      }
    },
  };
  const finish = async (cp: Checkpoint): Promise<number> => {
    const out = await execute(cp, env, store, execOpts);
    console.log(`\n${renderReceipt(cp)}`);
    if (out.kind === "done") return 0;
    if (out.kind === "failed") {
      console.log(`\nStopped at step ${out.step.index + 1}: ${out.error}`);
      return 1;
    }
    console.log(`\nStill waiting on step ${out.step.index + 1}: ${out.reason}`);
    console.log(`Run "nearcast resume ${args.file}" to continue.`);
    return 3;
  };

  if (args.cmd === "status") {
    if (!existing) {
      console.log("No run recorded for this exact script text and account.");
      return 1;
    }
    console.log(renderReceipt(existing));
    return 0;
  }

  if (args.cmd === "resume") {
    if (!existing) {
      throw new Error(
        "no run to resume for this exact script text and account. Checkpoints are keyed by the script's hash, " +
          "so an edited script counts as a new script.",
      );
    }
    if (isComplete(existing)) {
      console.log(renderReceipt(existing));
      console.log("\nNothing to resume.");
      return 0;
    }
    console.log(`Resuming from ${path}\n`);
    return finish(existing);
  }

  // plan / run
  if (args.cmd === "run" && existing) {
    if (!isComplete(existing)) {
      console.error(`An unfinished run of this script exists. Use "nearcast resume ${args.file}" (or "nearcast status ${args.file}" to look).`);
      if (inFlight(existing).length) console.error("Some transactions are signed or in flight, so starting over could send them twice.");
      return 1;
    }
    if (!args.fresh) {
      console.log(renderReceipt(existing));
      console.log("\nThis script already ran to completion. Pass --fresh to run it again.");
      return 0;
    }
  }

  const p = await plan(source, env);
  console.log(renderPlan(p, args.file));
  const problems = planProblems(p);
  if (args.cmd === "plan") return problems.length ? 2 : 0;
  if (problems.length) {
    console.error("\nNot running: fix the blocked items above first. Nothing was signed.");
    return 2;
  }
  const txCount = p.steps.filter((s) => s.type !== "assert").length;
  if (args.network === "mainnet" && args.yes && process.env.NEARCAST_ALLOW_MAINNET_YES !== "1") {
    throw new Error("--yes is disabled on mainnet; confirm interactively (or set NEARCAST_ALLOW_MAINNET_YES=1)");
  }
  if (txCount === 0) {
    console.log("\nNo transactions to send.");
    return 0;
  }
  if (!args.yes) {
    if (!process.stdin.isTTY) throw new Error("refusing to sign without confirmation: run in a terminal or pass --yes");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const phrase = args.network === "mainnet" ? "send on mainnet" : "yes";
    const answer = await rl.question(`\nMode: EXECUTE | Network: ${args.network}. Sign and send these ${txCount} transaction(s) as ${p.account}? Type "${phrase}" to proceed: `);
    rl.close();
    if (answer.trim().toLowerCase() !== phrase) {
      console.log("Cancelled. Nothing was signed.");
      return 1;
    }
  }
  if (existing) renameSync(path, path.replace(/\.json$/, `.${Date.now()}.done.json`));
  const cp = newCheckpoint(p);
  store.save(cp);
  console.log(`\nRunning. Checkpoint: ${path}\n`);
  return finish(cp);
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof ScriptError ? `Script error, ${e.message}` : `Error: ${e?.message ?? e}`);
    process.exit(1);
  },
);
