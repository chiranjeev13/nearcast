import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { intentsEnv } from "../chains/intents.js";
import { buildDocs, intentAssets } from "../docs.js";
import type { Env } from "../env.js";
import { checkpointPath, fileStore, inFlight, isComplete, newCheckpoint, type Store } from "../exec/checkpoint.js";
import { execute, type Outcome, type WalletResult } from "../exec/executor.js";
import { ScriptError } from "../lang/ast.js";
import { planProblems } from "../plan/problems.js";
import { plan, scriptHash } from "../plan/planner.js";
import type { Checkpoint, NearAction, NearTxStep, Plan } from "../plan/types.js";
import { NETWORKS, isNetwork } from "../registry.js";
import type { Ctx, InfoResponse, Snapshot, WalletAction, WalletRequest } from "./api.js";
import { planView } from "./view.js";

class Killed extends Error {}

interface Run {
  cp: Checkpoint;
  running: boolean;
  kill: boolean;
  log: string[];
  outcome?: string;
  wallet?: { req: WalletRequest; resolve: (r: WalletResult) => void; reject: (e: Error) => void };
}

export interface UiOptions {
  /** Env for one (network, account). In wallet mode the account's own key is never used. */
  makeEnv(network: string, account: string, signer: Ctx["signer"]): Env;
  keyAccounts(network: string): string[];
  defaultNetwork: string;
  defaultAccount?: string;
  stateDir: string;
  port: number;
  initialScript?: string;
  examplesDir: string;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".wasm": "application/wasm",
};

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

/**
 * Local web UI. It drives the same planner, executor and checkpoint files as the CLI.
 * It can hold signing keys, so it listens on 127.0.0.1 only and every API call must carry a
 * per-process token that only the served page knows.
 */
export function startUi(o: UiOptions): Promise<string> {
  const token = process.env.NEARCAST_UI_TOKEN ?? randomBytes(24).toString("hex");
  const here = dirname(fileURLToPath(import.meta.url));
  const webDist = resolve(here, "..", "..", "web", "dist");
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
    const account = String(c.account ?? "");
    if (!account) throw new Error(c.signer === "wallet" ? "connect a wallet first" : "no account: pick a key account or connect a wallet");
    const signer = c.signer === "wallet" ? "wallet" : "key";
    if (signer === "key" && !o.keyAccounts(network).includes(account)) {
      throw new Error(`no local key for ${account} on ${network}; connect a wallet instead`);
    }
    return { network, account, signer, walletId: typeof c.walletId === "string" ? c.walletId : undefined };
  };
  const envFor = (c: Ctx): Env => {
    const k = `${c.network}|${c.account}|${c.signer}`;
    let e = envs.get(k);
    if (!e) {
      e = o.makeEnv(c.network, c.account, c.signer);
      envs.set(k, e);
    }
    return e;
  };
  const runKey = (c: Ctx, hash: string) => `${c.network}|${c.account}|${hash}`;
  const storeFor = (c: Ctx, hash: string): { store: Store; path: string } => {
    const path = checkpointPath(resolve(o.stateDir), c.network, c.account, hash);
    return { store: fileStore(path), path };
  };

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
      if (s) handoff = { step: s.index + 1, stepId: s.id, title: s.description, since: cp.state[s.id].handoff!, account: (s as NearTxStep).sender };
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
            req: { id: randomUUID(), step: step.index + 1, title: step.description, signerId: step.sender, receiverId: step.receiver, actions: wa },
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
    async info(): Promise<InfoResponse> {
      await Promise.race([assets, new Promise((r) => setTimeout(r, 4000))]);
      const examples = existsSync(o.examplesDir)
        ? readdirSync(o.examplesDir).filter((f) => f.endsWith(".cast")).sort().map((f) => ({ name: f, source: readFileSync(join(o.examplesDir, f), "utf8") }))
        : [];
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
      const { store, path } = storeFor(c, p.scriptHash);
      const existing = store.load();
      if (existing && !isComplete(existing)) throw new Error("an unfinished run exists for this script: resume it instead");
      if (existing && !body.fresh) throw new Error("this script already ran to completion");
      const problems = planProblems(p);
      if (problems.length) throw new Error(`blocked: ${problems[0]}`);
      if (existing) renameSync(path, path.replace(/\.json$/, `.${Date.now()}.done.json`));
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
      if (typeof body.txHash === "string" && /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(body.txHash)) run.wallet.resolve({ txHash: body.txHash });
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
        if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(body.txHash)) throw new Error("that is not a NEAR transaction hash");
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

  const page = (): string => {
    const f = join(webDist, "index.html");
    if (!existsSync(f)) return "<!doctype html><title>nearcast</title><pre>Web UI not built. Run: npm run build:web</pre>";
    return readFileSync(f, "utf8").replace(/__NEARCAST_TOKEN__/g, token);
  };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const send = (code: number, body: unknown, type = "application/json") => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    try {
      // Reject anything not addressed to localhost (DNS rebinding) and anything without the token (cross-site requests).
      const host = (req.headers.host ?? "").replace(/:\d+$/, "");
      if (host !== "127.0.0.1" && host !== "localhost") return send(403, { error: "forbidden" });
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) return send(200, page(), MIME[".html"]);
      if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
        const f = normalize(join(webDist, url.pathname));
        if (!f.startsWith(webDist + "/") || !existsSync(f)) return send(404, { error: "not found" });
        res.writeHead(200, { "content-type": MIME[extname(f)] ?? "application/octet-stream", "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" });
        return res.end(readFileSync(f));
      }
      const name = /^\/api\/([a-z]+)$/.exec(url.pathname)?.[1];
      if (req.method !== "POST" || !name || !api[name]) return send(404, { error: "not found" });
      if (req.headers["x-nearcast-token"] !== token) return send(403, { error: "forbidden" });
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 8_000_000) return send(413, { error: "too large" });
      }
      send(200, await api[name](raw ? JSON.parse(raw) : {}));
    } catch (e) {
      const line = e instanceof ScriptError ? e.loc?.line : undefined;
      send(400, { error: (e as Error).message, line });
    }
  });

  return new Promise((ok, fail) => {
    server.on("error", fail);
    server.listen(o.port, "127.0.0.1", () => ok(`http://127.0.0.1:${o.port}/`));
  });
}
