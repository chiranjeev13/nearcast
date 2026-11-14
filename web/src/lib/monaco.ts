import { CompletionContext, type Completion } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { loader } from "@monaco-editor/react";
import editorWorker from "monaco-editor/editor/editor.worker?worker";
import * as monaco from "./monacoCore.ts";
import type { EntryDoc } from "@api";
import { castCompletions, type CompletionEnv } from "./completions.ts";

/**
 * Monaco (the editor inside VS Code) set up for .cast scripts: language, theme, IntelliSense, hovers.
 * Suggestions come from the same source as before (completions.ts); this file only adapts them.
 */

(self as any).MonacoEnvironment = { getWorker: () => new editorWorker() };
loader.config({ monaco: monaco as any });

export const LANG = "cast";
export const THEME = "nearcast-dark";
let registered = false;

function markdownFor(e: EntryDoc): monaco.IMarkdownString {
  const parts = ["```cast\n" + e.usage + "\n```", e.summary];
  if (e.details) parts.push(e.details);
  if (e.opts?.length) parts.push(e.opts.map((o) => `\`--${o.name}${o.value ? ` ${o.value}` : ""}\` ${o.summary}`).join("  \n"));
  if (e.example) parts.push("**Example**\n```cast\n" + e.example + "\n```");
  return { value: parts.join("\n\n") };
}

/** CodeMirror snippet template (`${name}`, `${}`) -> Monaco snippet (`${1:name}`, `$2`). */
export function toMonacoSnippet(t: string): string {
  let n = 0;
  return t
    .replace(/\$\{([^}]*)\}/g, (_m, name: string) => {
      n++;
      return name ? `\${${n}:${name}}` : `$${n}`;
    })
    .replace(/\t/g, "  ");
}

const KIND: Record<string, monaco.languages.CompletionItemKind> = {
  keyword: monaco.languages.CompletionItemKind.Keyword,
  function: monaco.languages.CompletionItemKind.Function,
  method: monaco.languages.CompletionItemKind.Method,
  variable: monaco.languages.CompletionItemKind.Variable,
  namespace: monaco.languages.CompletionItemKind.Module,
  property: monaco.languages.CompletionItemKind.Property,
  constant: monaco.languages.CompletionItemKind.Constant,
};

export function setupMonaco(getEnv: () => CompletionEnv): void {
  if (registered) return;
  registered = true;

  monaco.languages.register({ id: LANG, extensions: [".cast"] });
  monaco.languages.setLanguageConfiguration(LANG, {
    comments: { lineComment: "#" },
    brackets: [["(", ")"], ["{", "}"], ["[", "]"]],
    autoClosingPairs: [
      { open: "(", close: ")" },
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: '"', close: '"', notIn: ["string"] },
    ],
    wordPattern: /(-?\d*\.\d\w*)|([@$]?[\w.-]+(:[\w.-]+)?)/,
  });
  monaco.languages.setMonarchTokensProvider(LANG, {
    tokenizer: {
      root: [
        [/#.*$/, "comment"],
        [/^\s*(load|set|print|assert)\b/, "keyword"],
        [/^\s*[a-z][\w-]*:[a-z][\w-]*/, "function"],
        [/^\s*(call|transfer|batch|seq|as|exec)\b/, "function"],
        [/@[\w-]+(:[\w-]+)?/, "type"],
        [/\$[A-Za-z_]\w*/, "variable"],
        [/--[\w-]+/, "attribute"],
        [/"([^"\\]|\\.)*"/, "string"],
        [/0x[0-9a-fA-F]+/, "number.hex"],
        [/\b\d+(\.\d+)?(e\d+)?(near|yocto|tgas)?\b/, "number"],
        [/\b(from|to)\b/, "keyword.flow"],
        [/>=|<=|==|!=|>|</, "operator"],
        [/[(){}[\],]/, "delimiter"],
      ],
    },
  });
  // VS Code Dark Modern, with neon green where VS Code uses its blue accent.
  monaco.editor.defineTheme(THEME, {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "6A9955", fontStyle: "italic" },
      { token: "keyword", foreground: "C586C0" },
      { token: "keyword.flow", foreground: "569CD6" },
      { token: "function", foreground: "39FF14" },
      { token: "type", foreground: "DCDCAA" },
      { token: "variable", foreground: "9CDCFE" },
      { token: "attribute", foreground: "4FC1FF" },
      { token: "string", foreground: "CE9178" },
      { token: "number", foreground: "B5CEA8" },
      { token: "number.hex", foreground: "B5CEA8" },
      { token: "operator", foreground: "D4D4D4" },
    ],
    colors: {
      "editor.background": "#1F1F1F",
      "editor.foreground": "#CCCCCC",
      "editorLineNumber.foreground": "#6E7681",
      "editorLineNumber.activeForeground": "#CCCCCC",
      "editorCursor.foreground": "#39FF14",
      "editor.selectionBackground": "#264F78",
      "editor.lineHighlightBackground": "#FFFFFF08",
      "editorSuggestWidget.background": "#202020",
      "editorSuggestWidget.border": "#454545",
      "editorSuggestWidget.selectedBackground": "#04395E",
      "editorSuggestWidget.highlightForeground": "#39FF14",
      "editorSuggestWidget.focusHighlightForeground": "#39FF14",
      "editorHoverWidget.background": "#202020",
      "editorHoverWidget.border": "#454545",
      focusBorder: "#39FF14",
      "editorWidget.background": "#202020",
      "editorGutter.background": "#1F1F1F",
      "scrollbarSlider.background": "#79797966",
    },
  });

  monaco.languages.registerCompletionItemProvider(LANG, {
    triggerCharacters: ["@", "$", ":", "-", " "],
    provideCompletionItems(model, position, context) {
      const pos = model.getOffsetAt(position);
      const state = EditorState.create({ doc: model.getValue() });
      const explicit = context.triggerKind === monaco.languages.CompletionTriggerKind.Invoke;
      const r = castCompletions(getEnv)(new CompletionContext(state, pos, explicit));
      if (!r) return { suggestions: [] };
      const start = model.getPositionAt(r.from);
      const range = new monaco.Range(start.lineNumber, start.column, position.lineNumber, position.column);
      const options = r.options as (Completion & { snippet?: string; entry?: EntryDoc; retrigger?: boolean })[];
      return {
        suggestions: options.map((c, i) => ({
          label: c.label,
          kind: KIND[c.type ?? ""] ?? monaco.languages.CompletionItemKind.Text,
          detail: c.detail,
          documentation: c.entry ? markdownFor(c.entry) : typeof c.info === "string" ? c.info : undefined,
          insertText: c.snippet ? toMonacoSnippet(c.snippet) : c.label,
          insertTextRules: c.snippet ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
          // Higher boost first; ties keep the source's order.
          sortText: String(10000 - Math.round((c.boost ?? 0) * 100)).padStart(6, "0") + String(i).padStart(4, "0"),
          range,
          command: c.retrigger ? { id: "editor.action.triggerSuggest", title: "" } : undefined,
        })),
      };
    },
  });

  // Hover a command or helper to see its docs, like hovering a function in VS Code.
  monaco.languages.registerHoverProvider(LANG, {
    provideHover(model, position) {
      const docs = getEnv().docs;
      if (!docs) return null;
      const line = model.getLineContent(position.lineNumber);
      const re = /@?[A-Za-z][\w-]*(?::[A-Za-z][\w-]*)?/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line))) {
        const s = m.index + 1;
        const e = s + m[0].length;
        if (position.column < s || position.column > e) continue;
        const word = m[0];
        const entry = docs.entries.find((x) => x.insert === word);
        if (!entry) return null;
        return { range: new monaco.Range(position.lineNumber, s, position.lineNumber, e), contents: [markdownFor(entry)] };
      }
      return null;
    },
  });
}

export { monaco };
