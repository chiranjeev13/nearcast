#!/usr/bin/env node
// Mock of the nearcast UI server (src/ui/api.ts contract) with fixture data, for UI work.
//   node dev/mock-server.mjs            serves web/dist + /api on http://127.0.0.1:4142
//   MOCK_PORT=4141 node dev/mock-server.mjs
// The token is "mock" (also accepted from the Vite dev proxy via NEARCAST_UI_TOKEN=mock).
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.MOCK_PORT ?? 4142);
const TOKEN = "mock";
const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const KEY_ACCOUNT = "3d1ffede1e9f008991904e90bf0632d3d06f89dfa3cdde73862e13c1e1b7cf18";

// ---------------------------------------------------------------- docs fixture

const cmd = (module, name, usage, summary, extra = {}) => ({
  kind: "command", module, name, insert: module === "std" ? name : `${module}:${name}`, usage, summary, ...extra,
});
const helper = (module, name, usage, summary, extra = {}) => ({
  kind: "helper", module, name, insert: module === "std" ? `@${name}` : `@${module}:${name}`, usage, summary, ...extra,
});
const kw = (name, usage, summary, example) => ({ kind: "keyword", module: "", name, insert: name, usage, summary, example });

const docs = {
  modules: [
    { name: "std", summary: "Built-ins: contract calls, NEAR transfers, batches.", builtin: true },
    { name: "token", summary: "NEP-141 fungible tokens.", builtin: false },
    { name: "chainsig", summary: "Other chains through NEAR Chain Signatures.", builtin: false },
    { name: "account", summary: "Accounts, keys and contract deployment.", builtin: false },
  ],
  entries: [
    kw("load", "load <module>", "Make a module's commands and helpers available.", "load token"),
    kw("set", "set $name <value>", "Store a value in a variable.", 'set $to alice.testnet'),
    kw("print", "print <value>...", "Show values in the plan output.", 'print "treasury:" $treasury'),
    kw("assert", 'assert <left> <op> <right> ["message"]', "Stop unless a condition holds. Before any tx: preflight.", 'assert @balance > 1near "need 1 NEAR"'),
    cmd("std", "call", "call <contract> <method> [{json args}] [--deposit <amount>] [--gas <amount>]", "Call a NEAR contract method.", {
      opts: [{ name: "deposit", value: "<amount>", summary: "NEAR attached (e.g. 1yocto, 0.1near)" }, { name: "gas", value: "<amount>", summary: "Gas (default 30tgas)" }],
      example: 'call guest-book.testnet add_message {"text": "hi"} --deposit 0.01near', chains: ["near"],
    }),
    cmd("std", "transfer", "transfer <receiver> <amount>", "Send native NEAR.", { example: "transfer alice.testnet 0.5near", chains: ["near"] }),
    cmd("std", "batch", "batch <receiver> ( ... )", "Several actions to one receiver in one atomic transaction.", { block: true, example: "batch counter.testnet (\n  call counter.testnet increment\n  call counter.testnet increment\n)" }),
    cmd("token", "transfer", 'token:transfer <token> <recipient> <amount> [--memo "text"]', "Send NEP-141 tokens; registers the recipient if needed.", {
      opts: [{ name: "memo", value: '"text"', summary: "Memo stored with the transfer" }],
      example: "token:transfer USDC alice.testnet 1", chains: ["near"],
    }),
    cmd("token", "register", "token:register <token> [account]", "Pay storage so an account can hold a token.", { chains: ["near"] }),
    cmd("chainsig", "on", 'chainsig:on <chain> "<path>" ( exec ... )', "Run EVM calls from the address this account controls.", { block: true, example: 'chainsig:on base "treasury" (\n  exec @token(USDC) "transfer(address,uint256)" 0xdEaD 1e6\n)', chains: ["evm"] }),
    cmd("chainsig", "exec", 'exec <target> "<signature>" [args...] [--value <wei>] [--gas <limit>]', "One EVM contract call, inside chainsig:on.", { insert: "exec",
      opts: [{ name: "value", value: "<wei>", summary: "Native value sent" }, { name: "gas", value: "<limit>", summary: "Gas limit (default: estimated)" }], chains: ["evm"],
    }),
    cmd("chainsig", "transfer", 'chainsig:transfer <chain> "<path>" <to> <amount>', "Send the native coin on any supported chain.", { example: 'chainsig:transfer bitcoin "btc" tb1q... 0.0001', chains: ["evm", "bitcoin", "solana"] }),
    cmd("account", "create", "account:create <account> [--deposit <amount>] [--key <public key|new>]", "Create a sub-account or top-level account.", {
      opts: [{ name: "deposit", value: "<amount>", summary: "Initial balance (default 0.1near)" }, { name: "key", value: "<key|new>", summary: "Full-access key (default: new, saved locally)" }], chains: ["near"],
    }),
    cmd("account", "delete", "account:delete --beneficiary <account>", "Delete this account; the balance goes to the beneficiary.", { opts: [{ name: "beneficiary", value: "<account>", summary: "Receives the remaining balance" }], details: "Irreversible. Must be the last step for this account.", chains: ["near"] }),
    cmd("account", "deploy", "account:deploy <file.wasm> [--init <method>] [--args {json}]", "Deploy a contract to this account.", { chains: ["near"] }),
    helper("std", "me", "@me", "The account running the script."),
    helper("std", "view", "@view(<contract> <method> [{json args}])", "Read-only NEAR call."),
    helper("std", "balance", "@balance([account])", "NEAR balance in yocto."),
    helper("std", "token", "@token(<symbol>)", "Token contract for a symbol on the current chain."),
    helper("token", "balance", "@token:balance(<token> [account])", "Token balance in base units."),
    helper("token", "amount", "@token:amount(<token> <amount>)", "Whole tokens to base units."),
    helper("chainsig", "address", '@chainsig:address(<chain> "<path>")', "Address this account controls on a chain."),
    helper("chainsig", "balance", '@chainsig:balance(<chain> "<path>" [asset])', "Balance of a derived address, base units."),
  ],
  chains: {
    testnet: [
      { name: "base", label: "Base Sepolia", kind: "evm", symbol: "ETH", decimals: 18, tokens: ["USDC"] },
      { name: "ethereum", label: "Ethereum Sepolia", kind: "evm", symbol: "ETH", decimals: 18, tokens: ["USDC"] },
      { name: "bitcoin", label: "Bitcoin testnet4", kind: "btc", symbol: "BTC", decimals: 8, tokens: [] },
      { name: "solana", label: "Solana devnet", kind: "sol", symbol: "SOL", decimals: 9, tokens: [] },
    ],
    mainnet: [
      { name: "base", label: "Base", kind: "evm", symbol: "ETH", decimals: 18, tokens: ["USDC"] },
      { name: "ethereum", label: "Ethereum", kind: "evm", symbol: "ETH", decimals: 18, tokens: ["USDC", "USDT"] },
      { name: "bitcoin", label: "Bitcoin", kind: "btc", symbol: "BTC", decimals: 8, tokens: [] },
      { name: "solana", label: "Solana", kind: "sol", symbol: "SOL", decimals: 9, tokens: [] },
    ],
  },
  nearTokens: { testnet: ["USDC", "wNEAR"], mainnet: ["USDC", "USDT", "wNEAR"] },
  units: [
    { suffix: "near", summary: "1near = 10^24 yocto" },
    { suffix: "tgas", summary: "1tgas = 10^12 gas" },
    { suffix: "yocto", summary: "smallest NEAR unit" },
  ],
};

const EXAMPLE = `# One NEAR account pays out USDC on NEAR and on Base.
load token
load chainsig

set $treasury @chainsig:address(base "treasury")
print "treasury on Base:" $treasury

assert @chainsig:balance(base "treasury" ETH) > 0.0001e18 "treasury needs ETH on Base for gas"

token:transfer USDC alice.testnet 1

chainsig:on base "treasury" (
  exec @token(USDC) "transfer(address,uint256)" 0x000000000000000000000000000000000000dEaD 1e6
)
`;

// ---------------------------------------------------------------- plan fixture

function buildView(ctx, hash) {
  const near = `NEAR ${ctx.network}`;
  const signedWith = ctx.signer === "wallet" ? "wallet" : "key";
  const steps = [
    {
      n: 1, id: "s1", kind: "check", chain: "preflight check", title: "treasury needs ETH on Base for gas",
      line: 8, text: 'assert @chainsig:balance(base "treasury" ETH) > 0.0001e18 "treasury needs ETH on Base for gas"',
      rows: [["at plan time", "0.004 ETH (4000000000000000 wei) > 0.0001 ETH (100000000000000 wei) is true"]], actions: [], atomic: false,
      status: "planned", risk: ["read-only"],
    },
    {
      n: 2, id: "s2", kind: "near", chain: near, title: "Transfer 1 USDC to alice.testnet",
      line: 10, text: "token:transfer USDC alice.testnet 1",
      rows: [["from", ctx.account], ["to", "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af"], ["amount", "1 USDC (1000000 base units)"], ["max fee", "0.006 NEAR"]],
      actions: [
        "storage_deposit: register alice.testnet  ·  deposit 0.00125 NEAR, gas 30 Tgas",
        "ft_transfer: send 1 USDC (1000000 base units) to alice.testnet  ·  deposit 1 yoctoNEAR, gas 30 Tgas",
      ],
      atomic: true, status: "planned", signer: ctx.account, signedWith, risk: ["state-changing"],
    },
    {
      n: 3, id: "s3", kind: "near", chain: near, title: "Ask the MPC network to sign step 4",
      line: 13, text: 'exec @token(USDC) "transfer(address,uint256)" 0x000000000000000000000000000000000000dEaD 1e6',
      rows: [["from", ctx.account], ["to", ctx.network === "mainnet" ? "v1.signer" : "v1.signer-prod.testnet"], ["max fee", "0.005 NEAR"]],
      actions: ['sign payload 0x9f2c…a1 with key path "treasury" (secp256k1)  ·  deposit 1 yoctoNEAR, gas 50 Tgas'],
      atomic: false, status: "planned", signer: ctx.account, signedWith, risk: ["state-changing"],
    },
    {
      n: 4, id: "s4", kind: "evm", chain: ctx.network === "mainnet" ? "Base" : "Base Sepolia", title: "On Base, send 1 USDC to 0x0000…dEaD",
      line: 13, text: 'exec @token(USDC) "transfer(address,uint256)" 0x000000000000000000000000000000000000dEaD 1e6',
      rows: [
        ["from", "0xC3DF23dF6371Ce9c663092f079d641ec2962608E (derived, path \"treasury\")"],
        ["to", "0x036CbD53842c5426634e7929541eC2318f3dCF7e"],
        ["call", "transfer(address 0x000000000000000000000000000000000000dEaD, uint256 1000000)"],
        ["amount", "1 USDC (1000000 base units)"],
        ["nonce", "3 (pinned)"],
        ["max fee", "0.0000013 ETH (gas limit 65000)"],
      ],
      actions: [], atomic: false, status: "planned", signedWith: "mpc", risk: ["state-changing", "irreversible"],
      danger: "Moves value out on another chain; NEAR steps are not rolled back if this fails.",
    },
  ];
  return {
    hash, account: ctx.account, network: ctx.network, steps,
    prints: ["treasury on Base: 0xC3DF23dF6371Ce9c663092f079d641ec2962608E"],
    checks: [
      { level: "ok", description: `${ctx.account.slice(0, 12)}… has 4.98 NEAR; fees and deposits need at most 0.012 NEAR` },
      { level: "ok", description: "0xC3DF…608E on Base Sepolia has 0.004 ETH; gas needs at most 0.0000013 ETH" },
      { level: "warn", description: "line 13: gas estimated against current state; earlier steps may change it" },
    ],
    problems: [], txCount: 3, chainCount: 2,
    cost: "NEAR fees up to 0.011 NEAR, deposits 0.00125 NEAR, EVM gas up to 0.0000013 ETH",
    walletTxCount: ctx.signer === "wallet" ? 2 : 0,
    risk: "irreversible",
    simulated: ["balances read on NEAR and Base Sepolia", "alice.testnet registration checked", "EVM gas estimated on Base Sepolia", "nonce 3 pinned for 0xC3DF…608E"],
  };
}

// ---------------------------------------------------------------- run simulation

const runs = new Map(); // key -> run
const keyOf = (ctx, hash) => `${ctx.network}/${ctx.account}/${ctx.signer}/${hash}`;

function snapshot(run) {
  if (!run) return null;
  return {
    hash: run.hash, view: run.view, run: run.state, inFlight: 0, running: run.running, log: run.log, outcome: run.outcome,
    walletRequest: run.walletRequest, handoff: run.handoff,
  };
}

const say = (run, m) => run.log.push(`${new Date().toLocaleTimeString()}  ${m}`);

function advance(run) {
  if (!run.running) return;
  if (run.kill) {
    run.running = false;
    run.kill = false;
    run.state = "unfinished";
    if (run.walletRequest) {
      run.handoff = { step: run.walletRequest.step, stepId: `s${run.walletRequest.step}`, title: run.walletRequest.title, since: new Date().toISOString(), account: run.view.account };
      run.walletRequest = undefined;
    }
    run.outcome = "Killed mid-run. The checkpoint on disk is intact; press Resume.";
    say(run, run.outcome);
    return;
  }
  if (run.walletRequest) return setTimeout(() => advance(run), 300);
  const step = run.view.steps.find((s) => s.status !== "confirmed");
  if (!step) {
    run.running = false;
    run.state = "complete";
    run.outcome = "All steps confirmed.";
    say(run, run.outcome);
    return;
  }
  const fake = () => createHash("sha256").update(randomUUID()).digest("hex");
  if (step.kind === "check") {
    step.status = "confirmed";
    step.result = "0.004 ETH > 0.0001 ETH is true";
    say(run, `step ${step.n}: check passed`);
  } else if (step.status === "planned") {
    if (step.signedWith === "wallet") {
      run.walletRequest = {
        id: randomUUID(), step: step.n, title: step.title, signerId: run.view.account,
        receiverId: step.rows.find((r) => r[0] === "to")[1],
        actions: [{ type: "FunctionCall", params: { methodName: step.n === 2 ? "ft_transfer" : "sign", args: {}, gas: "30000000000000", deposit: "1" } }],
      };
      say(run, `step ${step.n}: waiting for the wallet`);
    } else {
      step.status = "signed";
      step.txHash = step.kind === "evm" ? `0x${fake()}` : fake().slice(0, 44);
      say(run, `step ${step.n}: signed ${step.txHash}`);
    }
  } else if (step.status === "signed") {
    step.status = "broadcast";
    step.url = step.kind === "evm" ? `https://sepolia.basescan.org/tx/${step.txHash}` : `https://testnet.nearblocks.io/txns/${step.txHash}`;
    say(run, `step ${step.n}: sent`);
  } else if (step.status === "broadcast") {
    if (run.failAt === step.n) {
      step.status = "failed";
      step.error = "reverted on Base Sepolia. Gas was spent and nonce 3 is used.";
      step.hint = "likely cause: treasury USDC balance below 1 USDC when mined\nnext: fund 0xC3DF…608E with USDC, edit the script (new hash) and simulate again";
      run.running = false;
      run.state = "unfinished";
      run.outcome = `Stopped at step ${step.n}: ${step.error}`;
      say(run, run.outcome);
      return;
    }
    step.status = "confirmed";
    step.fee = step.kind === "evm" ? "0.0000004 ETH" : "0.0009 NEAR";
    say(run, `step ${step.n}: confirmed`);
  }
  setTimeout(() => advance(run), 700);
}

// ---------------------------------------------------------------- api

function need(ctx) {
  if (!ctx?.network || !ctx?.account || !ctx?.signer) throw new Error("missing ctx");
}

const api = {
  async info() {
    return {
      networks: ["testnet", "mainnet"], defaultNetwork: "testnet",
      keyAccounts: { testnet: [KEY_ACCOUNT, "nearcast-demo.testnet"], mainnet: [] }, defaultAccount: KEY_ACCOUNT,
      examples: [{ name: "demo.cast", source: EXAMPLE }, { name: "smoke.cast", source: "# smallest real run\nload token\ntoken:transfer USDC alice.testnet 0.01\n" }],
      initial: EXAMPLE, docs,
    };
  },
  async plan({ ctx, source, fresh }) {
    need(ctx);
    const lines = String(source).split("\n");
    const bad = lines.findIndex((l) => /\boops\b/.test(l));
    if (bad >= 0) throw Object.assign(new Error(`line ${bad + 1}: unknown command "oops"`), { line: bad + 1 });
    const hash = createHash("sha256").update(String(source)).digest("hex");
    const key = keyOf(ctx, hash);
    const existing = runs.get(key);
    if (existing && (existing.state === "unfinished" || (existing.state === "complete" && !fresh))) return snapshot(existing);
    const run = { hash, view: buildView(ctx, hash), state: "none", running: false, log: [], ctx, failAt: /fail/.test(source) ? 4 : 0 };
    runs.set(key, run);
    return snapshot(run);
  },
  async state({ ctx, hash }) {
    need(ctx);
    const run = runs.get(keyOf(ctx, hash));
    if (!run) throw new Error("unknown script hash: simulate first");
    return snapshot(run);
  },
  async run({ ctx, hash }) {
    need(ctx);
    const run = runs.get(keyOf(ctx, hash));
    if (!run) throw new Error("simulate the script first: only a plan you have seen can be run");
    if (run.running) throw new Error("already running");
    if (run.state === "complete") {
      run.view = buildView(ctx, hash);
      run.log = [];
    }
    run.state = "unfinished";
    run.running = true;
    run.outcome = undefined;
    setTimeout(() => advance(run), 300);
    return snapshot(run);
  },
  async resume({ ctx, hash, retryFailed }) {
    need(ctx);
    const run = runs.get(keyOf(ctx, hash));
    if (!run || run.state !== "unfinished") throw new Error("nothing to resume");
    if (run.handoff) throw new Error("resolve the wallet handoff first");
    if (run.running) throw new Error("already running");
    for (const s of run.view.steps) if (s.status === "failed" && (retryFailed || s.kind === "check")) Object.assign(s, { status: "planned", error: undefined, hint: undefined });
    run.failAt = 0;
    run.running = true;
    run.outcome = undefined;
    say(run, "resuming from checkpoint");
    setTimeout(() => advance(run), 300);
    return snapshot(run);
  },
  async kill({ ctx, hash }) {
    need(ctx);
    const run = runs.get(keyOf(ctx, hash));
    if (!run?.running) throw new Error("nothing is running");
    run.kill = true;
    if (run.walletRequest) advance(run);
    return { ok: true };
  },
  async wallet({ ctx, hash, id, txHash, error }) {
    need(ctx);
    const run = runs.get(keyOf(ctx, hash));
    if (!run?.walletRequest || run.walletRequest.id !== id) throw new Error("no such wallet request (already answered?)");
    const step = run.view.steps[run.walletRequest.step - 1];
    run.walletRequest = undefined;
    if (error) {
      step.status = "failed";
      step.error = `wallet: ${error}`;
      step.hint = "next: press Resume to ask the wallet again; nothing was sent";
      run.running = false;
      run.state = "unfinished";
      run.outcome = `Stopped at step ${step.n}: ${step.error}`;
      say(run, run.outcome);
    } else {
      step.status = "broadcast";
      step.txHash = txHash;
      step.url = `https://${ctx.network === "testnet" ? "testnet." : ""}nearblocks.io/txns/${txHash}`;
      say(run, `step ${step.n}: wallet sent ${txHash}`);
    }
    return snapshot(run);
  },
  async handoff({ ctx, hash, step, txHash, notSent }) {
    need(ctx);
    const run = runs.get(keyOf(ctx, hash));
    if (!run?.handoff || run.handoff.stepId !== step) throw new Error("no handoff pending for that step");
    const s = run.view.steps.find((x) => x.id === step);
    run.handoff = undefined;
    if (txHash) Object.assign(s, { status: "broadcast", txHash });
    say(run, notSent ? `step ${s.n}: marked not sent; resume will ask the wallet again` : `step ${s.n}: recorded ${txHash}`);
    return snapshot(run);
  },
};

// ---------------------------------------------------------------- http

const TYPES = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2" };

createServer(async (req, res) => {
  const send = (code, body, type = "application/json") => {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
    res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET") {
      if (url.pathname === "/" || url.pathname === "/index.html") {
        const f = join(DIST, "index.html");
        if (!existsSync(f)) return send(500, "run `npm run build` in web/ first", "text/plain");
        return send(200, readFileSync(f, "utf8").replace("__NEARCAST_TOKEN__", TOKEN), TYPES[".html"]);
      }
      const p = normalize(join(DIST, url.pathname));
      if (p.startsWith(DIST) && existsSync(p)) return send(200, readFileSync(p), TYPES[extname(p)] ?? "application/octet-stream");
      return send(404, { error: "not found" });
    }
    const name = /^\/api\/([a-z]+)$/.exec(url.pathname)?.[1];
    if (req.method !== "POST" || !name || !api[name]) return send(404, { error: "not found" });
    if (req.headers["x-nearcast-token"] !== TOKEN) return send(403, { error: "forbidden" });
    let raw = "";
    for await (const c of req) raw += c;
    send(200, await api[name](raw ? JSON.parse(raw) : {}));
  } catch (e) {
    send(400, { error: e.message, line: e.line });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`nearcast mock on http://127.0.0.1:${PORT}/ (token "${TOKEN}")`));
