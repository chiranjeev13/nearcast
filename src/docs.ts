import { MODULES } from "./modules/index.js";
import type { IntentToken } from "./env.js";
import { CHAINS, EVM_TOKENS, INTENTS_CHAINS, NEAR_TOKENS, NETWORKS } from "./registry.js";
import type { ChainDoc, Docs, EntryDoc } from "./ui/api.js";

const KEYWORDS: EntryDoc[] = [
  { kind: "keyword", module: "", name: "load", insert: "load", usage: "load <module>", summary: "Make a module's commands and helpers available.", example: "load token" },
  { kind: "keyword", module: "", name: "set", insert: "set", usage: "set $name <value>", summary: "Store a value in a variable.", example: 'set $vault @chainsig:address(base "vault")' },
  { kind: "keyword", module: "", name: "print", insert: "print", usage: "print <value>...", summary: "Show values in the plan output.", example: 'print "vault:" $vault' },
  {
    kind: "keyword", module: "", name: "assert", insert: "assert", usage: 'assert <left> <op> <right> ["message"]',
    summary: "Check a condition. Before any transaction: blocks the plan. After one: stops the run there.",
    details: "Operators: > >= < <= == !=",
    example: 'assert @balance > 1near "need 1 NEAR"',
  },
];

/** Everything the docs pane and the editor's autocomplete need, built from the modules themselves. */
export function buildDocs(): Docs {
  const entries: EntryDoc[] = [...KEYWORDS];
  for (const m of Object.values(MODULES)) {
    const std = m.name === "std";
    for (const name of Object.keys(m.commands)) {
      const d = m.docs[name];
      if (!d) throw new Error(`internal: ${m.name}:${name} has no docs`);
      // `exec` is written bare inside chainsig:on.
      const insert = std || (m.name === "chainsig" && name === "exec") ? name : `${m.name}:${name}`;
      entries.push({ kind: "command", module: m.name, name, insert, ...d });
    }
    for (const name of Object.keys(m.helpers)) {
      const d = m.docs[`@${name}`];
      if (!d) throw new Error(`internal: @${m.name}:${name} has no docs`);
      entries.push({ kind: "helper", module: m.name, name, insert: std ? `@${name}` : `@${m.name}:${name}`, ...d });
    }
  }
  const chains: Record<string, ChainDoc[]> = {};
  for (const n of NETWORKS) {
    chains[n] = Object.values(CHAINS[n]).map((c) => ({
      name: c.name,
      label: c.label,
      kind: c.kind,
      symbol: c.symbol,
      decimals: c.decimals,
      tokens: c.kind === "evm" ? Object.keys(EVM_TOKENS[c.chainId] ?? {}) : [],
    }));
  }
  return {
    modules: Object.values(MODULES).map((m) => ({ name: m.name, summary: m.summary, builtin: m.name === "std" })),
    entries,
    chains,
    nearTokens: Object.fromEntries(NETWORKS.map((n) => [n, Object.keys(NEAR_TOKENS[n])])),
    units: [
      { suffix: "near", summary: "1near = 10^24 yoctoNEAR" },
      { suffix: "tgas", summary: "1tgas = 10^12 gas" },
      { suffix: "yocto", summary: "smallest NEAR unit" },
      { suffix: "e<n>", summary: "exponent: 1e6 = 1000000, 0.5e18" },
    ],
  };
}

/** 1Click tokens -> `chain:SYMBOL` refs. Chains Nearcast can sign on use its names (arbitrum, not arb). */
export function intentAssets(tokens: IntentToken[]): NonNullable<Docs["intentAssets"]> {
  const byId = Object.fromEntries(Object.entries(INTENTS_CHAINS).map(([name, id]) => [id, name]));
  const seen = new Set<string>();
  const out: NonNullable<Docs["intentAssets"]> = [];
  for (const t of tokens) {
    if (/DEPRECATED/i.test(t.symbol) || !/^[A-Za-z0-9_.$-]+$/.test(t.symbol)) continue;
    const chain = byId[t.blockchain] ?? t.blockchain;
    const ref = `${chain}:${t.symbol}`;
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push({ ref, chain, symbol: t.symbol, known: t.blockchain in byId });
  }
  return out;
}

/** Plain-text reference for `nearcast docs`. */
export function renderDocs(filter?: string): string {
  const d = buildDocs();
  const out: string[] = [];
  const f = filter?.toLowerCase();
  for (const m of d.modules) {
    const list = d.entries.filter((e) => e.module === m.name && (!f || e.insert.toLowerCase().includes(f) || e.summary.toLowerCase().includes(f)));
    if (!list.length) continue;
    out.push(`${m.name}${m.builtin ? " (built in)" : `  (load ${m.name})`}  ${m.summary}`, "");
    for (const e of list) {
      out.push(`  ${e.usage}`, `      ${e.summary}`);
      for (const o of e.opts ?? []) out.push(`      --${o.name}${o.value ? ` ${o.value}` : ""}  ${o.summary}`);
    }
    out.push("");
  }
  const kws = d.entries.filter((e) => e.kind === "keyword" && (!f || e.name.includes(f)));
  if (kws.length) {
    out.push("language", "");
    for (const e of kws) out.push(`  ${e.usage}`, `      ${e.summary}`);
  }
  return out.join("\n");
}
