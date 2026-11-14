import {
  snippetCompletion,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import type { Text } from "@codemirror/state";
import type { ChainDoc, Docs, EntryDoc } from "@api";

export interface CompletionEnv {
  docs: Docs | null;
  network: string;
}

// ---------------------------------------------------------------- script facts

/** Modules loaded with `load x` anywhere in the script. */
function loadedModules(doc: Text): Set<string> {
  const out = new Set<string>(["std"]);
  for (const m of doc.toString().matchAll(/^\s*load\s+([A-Za-z][\w-]*)/gm)) out.add(m[1]);
  return out;
}

/** Variables set on lines before `lineNo`, newest last. */
function variablesBefore(doc: Text, lineNo: number): { name: string; line: number; value: string }[] {
  const out = new Map<string, { name: string; line: number; value: string }>();
  for (let i = 1; i < lineNo; i++) {
    const m = /^\s*set\s+\$([A-Za-z_]\w*)\s+(.*)$/.exec(doc.line(i).text);
    if (m) out.set(m[1], { name: m[1], line: i, value: m[2].replace(/\s+#.*$/, "") });
  }
  return [...out.values()];
}

/** The chain of the innermost open `chainsig:on <chain> ... (` block around `lineNo`, if any. */
function enclosingChain(doc: Text, lineNo: number): string | null {
  const stack: (string | null)[] = [];
  for (let i = 1; i < lineNo; i++) {
    const text = doc.line(i).text.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/#.*$/, "");
    const on = /^\s*chainsig:on\s+([\w-]+)/.exec(text);
    for (const ch of text) {
      if (ch === "(") stack.push(on && !text.trimStart().startsWith("@") ? on[1] : null);
      if (ch === ")") stack.pop();
    }
  }
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i]) return stack[i];
  return null;
}

/** Split the text before the cursor into whole tokens (strings kept intact). */
function tokenize(s: string): string[] {
  return s.match(/"(?:[^"\\]|\\.)*"?|@[\w:-]+\(|[()]|[^\s()"]+/g) ?? [];
}

/** Inside an unclosed string or after a comment marker: no completions. */
function inStringOrComment(before: string): boolean {
  let inStr = false;
  for (let i = 0; i < before.length; i++) {
    const c = before[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "#") return true;
  }
  return inStr;
}

// ---------------------------------------------------------------- rendering

function infoNode(e: EntryDoc): () => Node {
  return () => {
    const root = document.createElement("div");
    root.style.cssText = "display:flex;flex-direction:column;gap:6px;font-size:12px;line-height:1.5";
    const usage = document.createElement("div");
    usage.textContent = e.usage;
    usage.style.cssText = "color:#39ff14;white-space:pre-wrap";
    root.append(usage);
    const sum = document.createElement("div");
    sum.textContent = e.summary;
    sum.style.color = "#e6e9e4";
    root.append(sum);
    if (e.details) {
      const d = document.createElement("div");
      d.textContent = e.details;
      d.style.color = "#9aa09a";
      root.append(d);
    }
    if (e.opts?.length) {
      const o = document.createElement("div");
      o.style.color = "#9aa09a";
      o.innerHTML = "";
      for (const opt of e.opts) {
        const row = document.createElement("div");
        const name = document.createElement("span");
        name.textContent = `--${opt.name}${opt.value ? ` ${opt.value}` : ""}  `;
        name.style.color = "#6fd3d6";
        row.append(name, document.createTextNode(opt.summary));
        o.append(row);
      }
      root.append(o);
    }
    if (e.example) {
      const ex = document.createElement("pre");
      ex.textContent = e.example;
      ex.style.cssText = "margin:0;padding:6px 8px;background:#0a0b0a;border:1px solid #2a2d2a;color:#d7dad5;white-space:pre-wrap";
      root.append(ex);
    }
    return root;
  };
}

/** Snippet from a usage line: required <args> become fields, [optional] parts are dropped. */
export function snippetFor(e: EntryDoc): string {
  // Drop the command/helper name as the usage spells it (it may differ from `insert`, e.g. bare `exec`).
  let rest = e.kind === "helper" ? e.usage.replace(/^@[\w:-]+/, "") : e.usage.replace(/^\S+/, "");
  if (e.kind === "helper") {
    const m = /^\(([^)]*)\)/.exec(rest);
    if (!m) return e.insert;
    const args = m[1].replace(/\[.*$/, "").trim();
    return `${e.insert}(${args.replace(/<([^>]+)>/g, (_x, n) => "${" + n + "}")})`;
  }
  rest = rest.replace(/\(.*$/s, "").replace(/\[.*$/s, "").trim();
  const args = rest.replace(/[{}$]/g, "").replace(/<([^>]+)>/g, (_x, n) => "${" + n + "}");
  let s = e.insert + (args ? ` ${args}` : "");
  if (e.block) s += " (\n\t${}\n)";
  return s;
}

function entryCompletion(e: EntryDoc, boost: number): Completion {
  const label = e.insert;
  const base: Completion = {
    label,
    detail: e.kind === "keyword" ? e.summary : e.usage.slice(e.insert.length).trim() || e.summary,
    info: infoNode(e),
    type: e.kind === "keyword" ? "keyword" : e.kind === "helper" ? "method" : "function",
    boost,
  };
  const snip = snippetFor(e);
  // Carried along for the Monaco adapter: the raw template and the docs entry.
  Object.assign(base, { snippet: snip.includes("${") ? snip : undefined, entry: e });
  return snip.includes("${") ? Object.assign(snippetCompletion(snip, base), { snippet: snip, entry: e }) : base;
}

function chainCompletions(chains: ChainDoc[]): Completion[] {
  return chains.map((c) => ({ label: c.name, detail: `${c.label} · ${c.symbol}`, type: "constant" }));
}

const COMMON = ["USDC", "USDT", "ETH", "BTC", "SOL", "wNEAR", "NEAR"];

/** `chain:TOKEN` refs NEAR Intents can move. Before the colon: chains first; after it: that chain's tokens. */
function intentAssetCompletions(docs: Docs, typed: string): Completion[] {
  const assets = docs.intentAssets ?? [];
  const colon = typed.indexOf(":");
  if (colon < 0) {
    // Chains (insert "base:" and reopen the list) plus every full ref, so "arb" finds "arbitrum:USDC" too.
    const chains = new Map<string, { known: boolean; n: number }>();
    for (const a of assets) {
      const c = chains.get(a.chain) ?? { known: a.known, n: 0 };
      c.n++;
      chains.set(a.chain, c);
    }
    const chainOpts: Completion[] = [...chains].map(([chain, c]) => ({
      label: `${chain}:`,
      detail: `${c.n} token${c.n === 1 ? "" : "s"}${c.known ? "" : " · needs --to"}`,
      type: "namespace",
      boost: c.known ? 3 : 0,
      apply: (view, _c, from, to) => {
        view.dispatch({ changes: { from, to, insert: `${chain}:` }, selection: { anchor: from + chain.length + 1 } });
        startCompletion(view);
      },
      // Monaco adapter: insert the label, then reopen suggestions.
      retrigger: true,
    }));
    return [...chainOpts, ...assets.map((a) => assetOption(a))];
  }
  const chain = typed.slice(0, colon);
  return assets.filter((a) => a.chain === chain).map((a) => assetOption(a));
}

function assetOption(a: NonNullable<Docs["intentAssets"]>[number]): Completion {
  const common = COMMON.indexOf(a.symbol);
  return {
    label: a.ref,
    detail: a.known ? "NEAR Intents" : "NEAR Intents · needs --to",
    type: "constant",
    boost: (a.known ? 1 : -1) + (common >= 0 ? 2 - common / 10 : 0),
  };
}

// ---------------------------------------------------------------- the source

export function castCompletions(get: () => CompletionEnv) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const { docs, network } = get();
    if (!docs) return null;
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = line.text.slice(0, ctx.pos - line.from);
    if (inStringOrComment(before)) return null;

    const loaded = loadedModules(ctx.state.doc);
    const chains = docs.chains[network] ?? [];
    const chainOf = (name: string) => chains.find((c) => c.name === name);

    // $variables
    const v = /\$[\w]*$/.exec(before);
    if (v) {
      return {
        from: ctx.pos - v[0].length,
        options: variablesBefore(ctx.state.doc, line.number).reverse().map((x, i) => ({
          label: `$${x.name}`,
          detail: x.value,
          type: "variable",
          boost: -i,
        })),
        validFor: /^\$\w*$/,
      };
    }

    // @helpers
    const h = /@[\w-]*(?::[\w-]*)?$/.exec(before);
    if (h) {
      return {
        from: ctx.pos - h[0].length,
        options: docs.entries
          .filter((e) => e.kind === "helper")
          .map((e) => entryCompletion(e, loaded.has(e.module) ? 1 : -1)),
        validFor: /^@[\w-]*(?::[\w-]*)?$/,
      };
    }

    const tokens = tokenize(before);
    const atBoundary = /\s$/.test(before) || before === "" || /[(]$/.test(before);
    const current = atBoundary ? "" : tokens[tokens.length - 1] ?? "";
    const prior = atBoundary ? tokens : tokens.slice(0, -1);
    const from = ctx.pos - current.length;
    const head = prior[0];

    // --options of the command on this line
    if (current.startsWith("-")) {
      const cmd = docs.entries.find((e) => e.kind === "command" && e.insert === head);
      if (!cmd?.opts?.length) return null;
      return {
        from,
        options: cmd.opts.map((o) => ({ label: `--${o.name}`, detail: o.value ?? "", info: o.summary, type: "property" })),
        validFor: /^-{0,2}[\w-]*$/,
      };
    }

    // Statement start: keywords, std commands, module:command.
    if (prior.length === 0 || (prior.length === 1 && prior[0] === ")")) {
      if (!ctx.explicit && current === "") return null;
      const inEvm = enclosingChain(ctx.state.doc, line.number);
      return {
        from,
        options: docs.entries
          .filter((e) => e.kind === "keyword" || e.kind === "command")
          .map((e, i) => {
            let boost = e.kind === "keyword" ? 2 : loaded.has(e.module) ? 1 : -2;
            if (inEvm && (e.insert === "exec" || e.name === "exec")) boost = 5;
            // Ties keep the documented order (each module lists its main command first),
            // instead of CodeMirror's alphabetical fallback.
            return entryCompletion(e, boost - i / 1000);
          }),
        validFor: /^[\w:.-]*$/,
      };
    }

    // Open helper call: which helper, and the complete arguments typed so far.
    const openHelper = (() => {
      let depth = 0;
      for (let i = prior.length - 1; i >= 0; i--) {
        const tk = prior[i];
        if (tk === ")") depth++;
        else if (tk.startsWith("@") && tk.endsWith("(")) {
          if (depth === 0) {
            const args = prior.slice(i + 1);
            return { name: tk.slice(0, -1), args, argIndex: args.length };
          }
          depth--;
        }
      }
      return null;
    })();

    const symbols = (chainName: string | null, native = false): Completion[] => {
      if (chainName) {
        const c = chainOf(chainName);
        if (!c) return [];
        return [
          ...(native ? [{ label: c.symbol, detail: `native · ${c.label}`, type: "constant" }] : []),
          ...c.tokens.map((s) => ({ label: s, detail: c.label, type: "constant" })),
        ];
      }
      return (docs.nearTokens[network] ?? []).map((s) => ({ label: s, detail: `NEAR ${network}`, type: "constant" }));
    };
    const res = (options: Completion[]): CompletionResult | null =>
      options.length ? { from, options, validFor: /^[\w.-]*$/ } : null;

    if (openHelper) {
      const { name, argIndex } = openHelper;
      if (name.startsWith("@chainsig:") && argIndex === 0) return res(chainCompletions(chains));
      if (name === "@chainsig:balance" && argIndex === 2) {
        const chainArg = openHelper.args[0];
        return res(symbols(chainArg && chainOf(chainArg) ? chainArg : null, true));
      }
      if ((name === "@token" || name.startsWith("@token:")) && argIndex === 0) {
        return res(symbols(enclosingChain(ctx.state.doc, line.number)));
      }
      return null;
    }

    const argIndex = prior.length - 1;
    if (head === "load" && argIndex === 0) {
      return res(
        docs.modules
          .filter((m) => !m.builtin)
          .map((m) => ({ label: m.name, detail: loaded.has(m.name) ? "loaded" : "", info: m.summary, type: "namespace" })),
      );
    }
    if (head?.startsWith("chainsig:") && argIndex === 0 && head !== "chainsig:exec") return res(chainCompletions(chains));
    if (head?.startsWith("token:") && argIndex === 0) return res(symbols(enclosingChain(ctx.state.doc, line.number)));
    // intents:swap <amount> <from chain:TOKEN> <to chain:TOKEN>
    if (head === "intents:swap") {
      // `from` / `to` are optional connecting words: count only the real arguments.
      const real = prior.slice(1).filter((t) => t !== "from" && t !== "to" && !t.startsWith("-"));
      const last = prior[prior.length - 1];
      if (real.length === 1 || real.length === 2) {
        const word = real.length === 1 ? "from" : "to";
        const assets = intentAssetCompletions(docs, current);
        // Offer the connecting word too, unless it was just typed.
        const kw: Completion[] = last === word || current.includes(":")
          ? []
          : [{ label: word, detail: real.length === 1 ? "source asset" : "destination asset", type: "keyword", boost: 4 }];
        return res([...kw, ...assets]);
      }
    }
    return null;
  };
}
