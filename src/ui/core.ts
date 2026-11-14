import { intentsEnv } from "../chains/intents.js";
import { buildDocs, intentAssets } from "../docs.js";
import type { Env } from "../env.js";
import { inFlight, isComplete, newCheckpoint, type Store } from "../exec/store.js";
import { execute, type Outcome, type WalletResult } from "../exec/executor.js";
import { planProblems } from "../plan/problems.js";
import { plan, scriptHash } from "../plan/planner.js";
import type { Checkpoint, EvmWalletTxStep, NearAction, NearTxStep, Plan } from "../plan/types.js";
import { envVar } from "../portable.js";
import { CHAINS, NETWORKS, isNetwork, type EvmDef } from "../registry.js";
import type { Ctx, FileEntry, InfoResponse, Snapshot, WalletAction, WalletRequest } from "./api.js";
import { planView } from "./view.js";

/**
 * The web app's API (plan, run, resume, wallet answers, files), independent of where it runs:
 * the local server exposes it over HTTP with files on disk; the hosted app calls it directly in
 * the browser with browser storage. Storage is injected; everything else is shared.
 */

class Killed extends Error {}

interface Run {
  cp: Checkpoint;
  running: boolean;
  kill: boolean;
  log: string[];
  outcome?: string;
  wallet?: { req: WalletRequest; resolve: (r: WalletResult) => void; reject: (e: Error) => void };
}

/** NEAR actions -> Wallet Selector's action JSON (amounts as decimal strings, code as base64). */
export function toWalletActions(actions: NearAction[]): WalletAction[] {
  return actions.map((a): WalletAction => {
    switch (a.kind) {
      case "call":
        return { type: "FunctionCall", params: { methodName: a.method, args: a.args as object, gas: a.gas.toString(), deposit: a.deposit.toString() } };
      case "transfer":
        return { type: "Transfer", params: { deposit: a.deposit.toString() } };
      case "create-account":
        return { type: "CreateAccount" };
      case "delete-account":
        return { type: "DeleteAccount", params: { beneficiaryId: a.beneficiary } };
      case "add-key":
        return {
          type: "AddKey",
          params: {
            publicKey: a.publicKey,
            accessKey: {
              permission: a.permission === "full"
                ? "FullAccess"
                : { receiverId: a.permission.receiver, methodNames: a.permission.methods, ...(a.permission.allowance !== null ? { allowance: a.permission.allowance.toString() } : {}) },
            },
          },
        };
      case "delete-key":
        return { type: "DeleteKey", params: { publicKey: a.publicKey } };
      case "deploy":
        return { type: "DeployContract", params: { code: a.codeBase64 } };
      case "stake":
        return { type: "Stake", params: { stake: a.amount.toString(), publicKey: a.publicKey } };
      default:
        throw new Error(`${a.kind} cannot be signed by a browser wallet; use a local key (signer: key)`);
    }
  });
}

/** Wallet-specific limits, found at plan time so they never surprise a run. */
function walletChecks(p: Plan, env: Env, walletId?: string): void {
  for (const s of p.steps) {
    if (s.type !== "near-tx" || env.near.canSign(s.sender)) continue;
    try {
      toWalletActions(s.actions);
    } catch (e) {
      p.checks.push({ level: "fail", description: `step ${s.index + 1}: ${(e as Error).message}` });
    }
    if (walletId === "ethereum-wallets" && s.actions.length > 1) {
      p.checks.push({
        level: "fail",
        description: `step ${s.index + 1}: MetaMask sends each action as its own transaction, so these ${s.actions.length} actions would not be atomic. Use a NEAR wallet or a local key.`,
      });
    }
  }
}

/** The user's scripts. Names arrive validated (`fileName`). */
export interface FilesBackend {
  dir: string;
  list(): Promise<FileEntry[]> | FileEntry[];
  read(name: string): Promise<string> | string;
  write(name: string, source: string, create: boolean): Promise<FileEntry> | FileEntry;
  rename(from: string, to: string): Promise<FileEntry> | FileEntry;
  remove(name: string): Promise<void> | void;
}

export interface CoreOptions {
  /** Env for one (network, account). In wallet mode the account's own key is never used. */
  makeEnv(network: string, account: string, signer: Ctx["signer"], evmAccount?: `0x${string}`): Env;
  keyAccounts(network: string): string[];
  defaultNetwork: string;
  defaultAccount?: string;
  initialScript?: string;
  examples(): { name: string; source: string }[];
  /** The checkpoint of one run; `archive` keeps a finished run aside before a fresh one starts. */
  checkpoints(network: string, account: string, hash: string): { store: Store; archive(): void };
  files: FilesBackend;
}

/** Only `<name>.cast` file names, no paths. */
export function fileName(raw: unknown): string {
  let n = String(raw ?? "").trim();
  if (!n.endsWith(".cast")) n += ".cast";
  if (!/^[A-Za-z0-9_][A-Za-z0-9 _.-]{0,80}\.cast$/.test(n) || n.includes("..")) {
    throw new Error("file names may use letters, digits, space, _ . - and end in .cast");
  }
  return n;
}

export function createApi(o: CoreOptions): Record<string, (body: any) => Promise<unknown>> {
  const pending = new Map<string, Plan>();
  const runs = new Map<string, Run>();
  const envs = new Map<string, Env>();
  const docs = buildDocs();
  // Live NEAR Intents assets for autocomplete. Best effort: the UI works without them.
  const assets = intentsEnv()
    .tokens()
    .then((t) => (docs.intentAssets = intentAssets(t)))
    .catch(() => (docs.intentAssets = []));

  const ctxOf = (body: any): Ctx & { walletId?: string } => {
    const c = body?.ctx ?? {};
    const network = String(c.network ?? o.defaultNetwork);
    if (!isNetwork(network)) throw new Error(`unknown network ${network}`);
    const evmAccount = typeof c.evmAccount === "string" && /^0x[0-9a-fA-F]{40}$/.test(c.evmAccount) ? c.evmAccount : undefined;
    // MetaMask alone is enough: its NEAR-side account is the lowercase address (an ETH-implicit account).
    const account = String(c.account || (c.signer === "wallet" && evmAccount ? evmAccount.toLowerCase() : ""));
    if (!account) throw new Error(c.signer === "wallet" ? "connect a wallet first" : "no account: pick a key account or connect a wallet");
    if (network === "mainnet" && account.endsWith(".testnet")) throw new Error(`${account} is a testnet account; connect a mainnet (.near) account or switch to testnet`);
    if (network === "testnet" && account.endsWith(".near")) throw new Error(`${account} is a mainnet account; connect a testnet account or switch to mainnet`);
    const signer = c.signer === "wallet" ? "wallet" : "key";
    if (signer === "key" && !o.keyAccounts(network).includes(account)) {
      throw new Error(`no local key for ${account} on ${network}; connect a wallet instead`);
    }
    return { network, account, signer, walletId: typeof c.walletId === "string" ? c.walletId : undefined, evmAccount };
  };
  const envFor = (c: Ctx): Env => {
    const k = `${c.network}|${c.account}|${c.signer}|${c.evmAccount ?? ""}`;
    let e = envs.get(k);
    if (!e) {
      e = o.makeEnv(c.network, c.account, c.signer, c.evmAccount as `0x${string}` | undefined);
      envs.set(k, e);
    }
    return e;
  };
  const runKey = (c: Ctx, hash: string) => `${c.network}|${c.account}|${hash}`;
  const storeFor = (c: Ctx, hash: string) => o.checkpoints(c.network, c.account, hash);

  const snapshot = (c: Ctx, hash: string, preferFresh = false): Snapshot => {
    const key = runKey(c, hash);
    const run = runs.get(key);
    const fresh = pending.get(key);
    let cp = run?.cp ?? storeFor(c, hash).store.load();
    if (preferFresh && fresh && cp && isComplete(cp)) cp = null;
    if (!cp && !fresh) return { hash, view: null, run: "none" };
    const env = envFor(c);
    const can = (id: string) => env.near.canSign(id);
    const view = cp ? planView(cp.plan, cp.state, can) : planView(fresh!, {}, can);
    let handoff: Snapshot["handoff"];
    if (cp && !run?.running) {
      const s = cp.plan.steps.find((x) => cp!.state[x.id]?.handoff && cp!.state[x.id].status === "planned");
      if (s) {
        const account = s.type === "evm-wallet-tx" ? s.from : (s as NearTxStep).sender;
        handoff = { step: s.index + 1, stepId: s.id, title: s.description, since: cp.state[s.id].handoff!, account };
      }
    }
    return {
      hash,
      view,
      run: !cp ? "none" : isComplete(cp) ? "complete" : "unfinished",
      inFlight: cp ? inFlight(cp).length : 0,
      running: run?.running ?? false,
      log: run?.log ?? [],
      outcome: run?.outcome,
      walletRequest: run?.wallet?.req,
      handoff,
    };
  };

  const start = (c: Ctx, hash: string, cp: Checkpoint, retryFailed: boolean) => {
    const key = runKey(c, hash);
    const { store } = storeFor(c, hash);
    const run: Run = { cp, running: true, kill: false, log: runs.get(key)?.log ?? [] };
    runs.set(key, run);
    const say = (m: string) => run.log.push(`${new Date().toLocaleTimeString()}  ${m}`);
    execute(cp, envFor(c), store, {
      log: say,
      retryFailed,
      afterPersist: () => {
        if (run.kill) throw new Killed();
      },
      wallet: (step: NearTxStep, actions: NearAction[]) =>
        new Promise<WalletResult>((resolveW, rejectW) => {
          let wa: WalletAction[];
          try {
            wa = toWalletActions(actions);
          } catch (e) {
            resolveW({ error: (e as Error).message });
            return;
          }
          run.wallet = {
            req: { id: globalThis.crypto.randomUUID(), kind: "near", step: step.index + 1, title: step.description, signerId: step.sender, receiverId: step.receiver, actions: wa },
            resolve: (r) => {
              run.wallet = undefined;
              resolveW(r);
            },
            reject: (e) => {
              run.wallet = undefined;
              rejectW(e);
            },
          };
        }),
      evmWallet: (step: EvmWalletTxStep) =>
        new Promise<WalletResult>((resolveW, rejectW) => {
          const def = Object.values(CHAINS[c.network as keyof typeof CHAINS]).find((x): x is EvmDef => x.kind === "evm" && x.chainId === step.chain.chainId);
          run.wallet = {
            req: {
              id: globalThis.crypto.randomUUID(), kind: "evm", step: step.index + 1, title: step.description, signerId: step.from, receiverId: step.to, actions: [],
              evm: {
                chainId: step.chain.chainId, chainName: step.chain.label, from: step.from, to: step.to, data: step.data, value: step.value.toString(),
                rpcUrl: def ? envVar(def.rpcEnv) ?? def.rpc : "", explorer: def ? def.explorer.replace(/\/tx\/$/, "") : "", symbol: step.chain.symbol,
              },
            },
            resolve: (r) => {
              run.wallet = undefined;
              resolveW(r);
            },
            reject: (e) => {
              run.wallet = undefined;
              rejectW(e);
            },
          };
        }),
    }).then(
      (out: Outcome) => {
        run.running = false;
        run.outcome = out.kind === "done" ? "All steps confirmed."
          : out.kind === "failed" ? `Stopped at step ${out.step.index + 1}: ${out.error}`
          : `Waiting on step ${out.step.index + 1}: ${out.reason}`;
        say(run.outcome);
      },
      (e) => {
        run.running = false;
        run.wallet = undefined;
        run.cp = store.load() ?? cp;
        run.outcome = e instanceof Killed ? "Killed mid-run. The checkpoint on disk is intact; press Resume." : `Error: ${e.message}`;
        say(run.outcome);
      },
    );
  };

  const api: Record<string, (body: any) => Promise<unknown>> = {
    async files() {
      return { dir: o.files.dir, files: await o.files.list() };
    },
    async read({ name }) {
      const n = fileName(name);
      return { name: n, source: await o.files.read(n) };
    },
    async write({ name, source, create }) {
      if (typeof source !== "string" || source.length > 1_000_000) throw new Error("bad file contents");
      return o.files.write(fileName(name), source, Boolean(create));
    },
    async rename({ from, to }) {
      return o.files.rename(fileName(from), fileName(to));
    },
    async delete({ name }) {
      await o.files.remove(fileName(name));
      return { ok: true };
    },
    async info(): Promise<InfoResponse> {
      await Promise.race([assets, new Promise((r) => setTimeout(r, 4000))]);
      const examples = o.examples();
      return {
        networks: [...NETWORKS],
        defaultNetwork: o.defaultNetwork as InfoResponse["defaultNetwork"],
        keyAccounts: Object.fromEntries(NETWORKS.map((n) => [n, o.keyAccounts(n)])),
        defaultAccount: o.defaultAccount,
        examples,
        initial: o.initialScript ?? examples.find((e) => e.name === "demo.cast")?.source ?? examples[0]?.source ?? "",
        docs,
      };
    },
    async docs() {
      return docs;
    },
    async plan(body) {
      const c = ctxOf(body);
      const source = String(body.source ?? "");
      const hash = scriptHash(source);
      const key = runKey(c, hash);
      const existing = runs.get(key)?.cp ?? storeFor(c, hash).store.load();
      // An unfinished run keeps its frozen plan: resume never re-plans.
      if (!existing || isComplete(existing)) {
        const env = envFor(c);
        const p = await plan(source, env);
        walletChecks(p, env, c.walletId);
        pending.set(key, p);
      }
      return snapshot(c, hash, Boolean(body.fresh));
    },
    async state(body) {
      const c = ctxOf(body);
      return snapshot(c, String(body.hash));
    },
    async run(body) {
      const c = ctxOf(body);
      const key = runKey(c, String(body.hash));
      const p = pending.get(key);
      if (!p) throw new Error("simulate the script first: only a plan you have seen can run");
      if (runs.get(key)?.running) throw new Error("already running");
      const { store, archive } = storeFor(c, p.scriptHash);
      const existing = store.load();
      if (existing && !isComplete(existing)) throw new Error("an unfinished run exists for this script: resume it instead");
      if (existing && !body.fresh) throw new Error("this script already ran to completion");
      const problems = planProblems(p);
      if (problems.length) throw new Error(`blocked: ${problems[0]}`);
      if (existing) archive();
      const cp = newCheckpoint(p);
      store.save(cp);
      runs.delete(key);
      pending.delete(key);
      start(c, p.scriptHash, cp, false);
      return snapshot(c, p.scriptHash);
    },
    async resume(body) {
      const c = ctxOf(body);
      const h = String(body.hash);
      if (runs.get(runKey(c, h))?.running) throw new Error("already running");
      const cp = storeFor(c, h).store.load();
      if (!cp) throw new Error("no run to resume for this exact script text");
      if (isComplete(cp)) throw new Error("nothing to resume: every step is confirmed");
      start(c, h, cp, Boolean(body.retryFailed));
      return snapshot(c, h);
    },
    async kill(body) {
      const c = ctxOf(body);
      const run = runs.get(runKey(c, String(body.hash)));
      if (!run?.running) throw new Error("nothing is running");
      run.kill = true;
      // A wallet request in progress has no persist to interrupt: end it here. Its step keeps the
      // handoff mark, so resume will ask a human what happened.
      run.wallet?.reject(new Killed());
      return { ok: true };
    },
    async wallet(body) {
      const c = ctxOf(body);
      const h = String(body.hash);
      const run = runs.get(runKey(c, h));
      if (!run?.wallet || run.wallet.req.id !== body.id) throw new Error("no such wallet request (already answered?)");
      const okHash = run.wallet.req.kind === "evm" ? /^0x[0-9a-fA-F]{64}$/ : /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
      if (typeof body.txHash === "string" && okHash.test(body.txHash)) run.wallet.resolve({ txHash: body.txHash });
      else run.wallet.resolve({ error: String(body.error ?? "no transaction hash returned") });
      return snapshot(c, h);
    },
    async handoff(body) {
      const c = ctxOf(body);
      const h = String(body.hash);
      if (runs.get(runKey(c, h))?.running) throw new Error("the run is active");
      const { store } = storeFor(c, h);
      const cp = store.load();
      const st = cp?.state[String(body.step)];
      if (!cp || !st?.handoff) throw new Error("nothing to resolve for that step");
      if (typeof body.txHash === "string" && body.txHash) {
        const evmStep = cp.plan.steps.find((x) => x.id === String(body.step))?.type === "evm-wallet-tx";
        if (evmStep ? !/^0x[0-9a-fA-F]{64}$/.test(body.txHash) : !/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(body.txHash)) {
          throw new Error(evmStep ? "that is not an EVM transaction hash (0x + 64 hex)" : "that is not a NEAR transaction hash");
        }
        cp.state[String(body.step)] = { ...st, status: "broadcast", txHash: body.txHash, handoff: undefined };
        cp.log.push({ at: new Date().toISOString(), step: String(body.step), event: `broadcast: hash ${body.txHash} given by the user` });
      } else if (body.notSent) {
        cp.state[String(body.step)] = { ...st, handoff: undefined };
        cp.log.push({ at: new Date().toISOString(), step: String(body.step), event: "user confirmed the wallet sent nothing" });
      } else throw new Error("give txHash or notSent");
      store.save(cp);
      const run = runs.get(runKey(c, h));
      if (run) run.cp = cp;
      return snapshot(c, h);
    },
  };

  return api;
}
