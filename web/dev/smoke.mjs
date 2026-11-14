// Walks the UI's API flow against a server (default: the mock). node dev/smoke.mjs [baseUrl] [token]
const B = process.argv[2] ?? "http://127.0.0.1:4142";
const T = process.argv[3] ?? "mock";
const call = async (name, body = {}) => {
  const r = await fetch(`${B}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", "x-nearcast-token": T }, body: JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) throw Object.assign(new Error(d.error), { line: d.line });
  return d;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => { if (!c) { console.error("FAIL", m); process.exit(1); } console.log("ok  ", m); };

const info = await call("info");
ok(info.docs.entries.length > 10 && info.examples.length > 0, `info: ${info.docs.entries.length} docs entries, ${info.examples.length} examples`);
const acct = info.defaultAccount;

try { await call("plan", { ctx: { network: "testnet", account: acct, signer: "key" }, source: "load token\noops" }); ok(false, "plan error expected"); }
catch (e) { ok(e.line === 2, `plan error carries line ${e.line}: ${e.message}`); }

for (const signer of ["key", "wallet"]) {
  const ctx = { network: "testnet", account: signer === "key" ? acct : "alice.testnet", signer };
  let s = await call("plan", { ctx, source: info.initial });
  ok(s.run === "none" && s.view.steps.every((x) => Array.isArray(x.risk)) && s.view.simulated.length > 0, `[${signer}] plan: ${s.view.steps.length} steps, risk ${s.view.risk}`);
  s = await call("run", { ctx, hash: s.hash });
  ok(s.running, `[${signer}] run started`);
  let answered = 0;
  for (let i = 0; i < 40 && (s.running || s.walletRequest); i++) {
    await sleep(400);
    s = await call("state", { ctx, hash: s.hash });
    if (s.walletRequest) {
      s = await call("wallet", { ctx, hash: s.hash, id: s.walletRequest.id, txHash: `walletTx${++answered}` });
    }
  }
  ok(s.run === "complete", `[${signer}] complete: ${s.view.steps.map((x) => x.status).join(",")} (${answered} wallet answers)`);
}

// failure + hint + resume
{
  const ctx = { network: "testnet", account: acct, signer: "key" };
  let s = await call("plan", { ctx, source: info.initial + "\n# fail" });
  s = await call("run", { ctx, hash: s.hash });
  for (let i = 0; i < 40 && s.running; i++) { await sleep(400); s = await call("state", { ctx, hash: s.hash }); }
  const failed = s.view.steps.find((x) => x.status === "failed");
  ok(failed?.hint, `failure carries hint: ${failed?.hint?.split("\n")[0]}`);
}

// kill during wallet request -> handoff
{
  const ctx = { network: "testnet", account: "bob.testnet", signer: "wallet" };
  let s = await call("plan", { ctx, source: info.initial + "\n# kill" });
  s = await call("run", { ctx, hash: s.hash });
  for (let i = 0; i < 20 && !s.walletRequest; i++) { await sleep(300); s = await call("state", { ctx, hash: s.hash }); }
  await call("kill", { ctx, hash: s.hash });
  s = await call("state", { ctx, hash: s.hash });
  ok(s.handoff && s.run === "unfinished", `kill during wallet request -> handoff for step ${s.handoff?.step}`);
  s = await call("handoff", { ctx, hash: s.hash, step: s.handoff.stepId, notSent: true });
  ok(!s.handoff, "handoff resolved (not sent)");
}
console.log("smoke passed");
