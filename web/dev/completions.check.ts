// Exercise the completion source with real CodeMirror state. Run: ../node_modules/.bin/tsx dev/completions.check.ts
import { CompletionContext, type Completion } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { castCompletions, snippetFor } from "../src/lib/completions.ts";

// The real docs, built from the modules themselves (no server needed).
const { buildDocs } = await import("../../src/docs.ts");
const info = { docs: buildDocs() };
// A slice of the live 1Click token list, as the server attaches it.
const { intentAssets } = await import("../../src/docs.ts");
const { INTENT_TOKENS } = await import("../../test/fake.ts");
info.docs.intentAssets = intentAssets(INTENT_TOKENS as any);
const source = castCompletions(() => ({ docs: info.docs, network: "testnet" }));

function at(text: string, explicit = false) {
  const pos = text.indexOf("|");
  const doc = text.replace("|", "");
  const state = EditorState.create({ doc });
  const r = source(new CompletionContext(state, pos, explicit));
  if (!r) return { from: -1, labels: [] as string[] };
  const typed = doc.slice(r.from, pos);
  const labels = (r.options as Completion[]).filter((o) => o.label.toLowerCase().startsWith(typed.toLowerCase())).sort((a, b) => (b.boost ?? 0) - (a.boost ?? 0)).map((o) => o.label);
  return { from: r.from, labels };
}
const check = (name: string, got: string[], want: string[]) => {
  const ok = want.every((w) => got.includes(w));
  console.log(ok ? "ok  " : "FAIL", name, "->", got.slice(0, 8).join(" "));
  if (!ok) process.exitCode = 1;
};

check("statement start `token:`", at("load token\ntoken:|").labels, ["token:transfer", "token:register"]);
check("statement start `lo`", at("lo|").labels, ["load"]);
check("statement start `ch` (unloaded module still offered)", at("ch|").labels, ["chainsig:on", "chainsig:transfer"]);
check("helpers `@tok`", at("set $x @tok|").labels, ["@token", "@token:balance", "@token:amount"]);
check("helpers `@chainsig:`", at("assert @chainsig:|").labels, ["@chainsig:address", "@chainsig:balance"]);
check("vars `$`", at("set $treasury 1\nset $to alice.testnet\nprint $|").labels, ["$to", "$treasury"]);
check("load module", at("load |").labels, ["token", "chainsig", "account"]);
check("options `--`", at("call x y --|").labels, ["--deposit", "--gas"]);
check("token:transfer first arg", at("load token\ntoken:transfer |").labels, ["USDC", "wNEAR"]);
check("chainsig:on chain", at("chainsig:on |").labels, ["base", "bitcoin", "solana"]);
check("@chainsig:balance chain", at('assert @chainsig:balance(|').labels, ["base", "ethereum"]);
check("@chainsig:balance asset", at('assert @chainsig:balance(base "t" |').labels, ["ETH", "USDC"]);
check("@token inside chainsig:on base", at('chainsig:on base "t" (\n  exec @token(|').labels, ["USDC"]);
check("exec boosted inside chainsig block", at('chainsig:on base "t" (\n  ex|').labels, ["exec"]);
check("intents:swap from asset (empty)", at("load intents\nintents:swap 10 |", true).labels, ["base:", "arbitrum:", "near:", "base:USDC"]);
check("intents:swap from asset `ba`", at("load intents\nintents:swap 10 ba|").labels, ["base:", "base:USDC", "base:ETH"]);
check("intents:swap after `base:`", at("load intents\nintents:swap 10 base:|").labels, ["base:USDC", "base:ETH"]);
check("intents:swap to asset `arbitrum:U`", at("load intents\nintents:swap 10 base:USDC arbitrum:U|").labels, ["arbitrum:USDC"]);
check("intents:swap other chains need --to", at("load intents\nintents:swap 10 base:USDC tr|").labels, ["tron:", "tron:USDT"]);
check("intents:swap `from` word offered", at("load intents\nintents:swap 100 f|").labels, ["from"]);
check("intents:swap after `from`", at("load intents\nintents:swap 100 from ba|").labels, ["base:", "base:USDC"]);
check("intents:swap `to` word offered", at("load intents\nintents:swap 100 from base:USDC t|").labels, ["to"]);
check("intents:swap after `to` (the reported case)", at("load intents\nintents:swap 100 from base:USDC to a|").labels, ["arbitrum:", "arbitrum:USDC"]);
check("intents:swap after `to arbitrum:`", at("load intents\nintents:swap 100 from base:USDC to arbitrum:|").labels, ["arbitrum:USDC"]);
check("no completion in string", at('print "tok|').labels, []);
check("no completion in comment", at("# tok|").labels, []);
console.log("snippets:");
for (const e of info.docs.entries.filter((e: any) => ["token:transfer", "chainsig:on", "exec", "@token:balance", "batch", "@me", "account:delete"].includes(e.insert))) console.log("   ", JSON.stringify(snippetFor(e)));
