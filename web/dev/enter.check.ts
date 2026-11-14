// Enter/Tab accept the highlighted suggestion instead of inserting a newline or indenting.
// Real CodeMirror view + the app's real extension stack, on happy-dom. Run: ../node_modules/.bin/tsx dev/enter.check.ts
import { Window } from "happy-dom";

const win = new Window({ url: "http://127.0.0.1/" });
for (const k of ["window", "document", "navigator", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "KeyboardEvent", "Node", "HTMLElement", "Element", "DOMRect", "ResizeObserver", "IntersectionObserver"]) {
  const v = (win as any)[k];
  if (v !== undefined) Object.defineProperty(globalThis, k, { value: typeof v === "function" && k !== "KeyboardEvent" && /^[a-z]/.test(k) ? v.bind(win) : v, configurable: true, writable: true });
}

const { EditorState, Prec } = await import("@codemirror/state");
const { EditorView, keymap, runScopeHandlers } = await import("@codemirror/view");
const { startCompletion, completionStatus, currentCompletions, acceptCompletion, completionKeymap } = await import("@codemirror/autocomplete");
const { getDefaultExtensions } = await import("@uiw/react-codemirror");
const { BASIC_SETUP, editorExtensions } = await import("../src/lib/editorExtensions.ts");
const { buildDocs } = await import("../../src/docs.ts");

const docs = buildDocs();
const env = () => ({ docs, network: "testnet" });
const DOC = "load token\ntoken:";

async function press(extra: any[], key: "Enter" | "Tab") {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent: parent as any,
    state: EditorState.create({
      doc: DOC,
      selection: { anchor: DOC.length },
      // Same order as @uiw/react-codemirror: its defaults (basicSetup) first, then ours.
      extensions: [...getDefaultExtensions({ basicSetup: BASIC_SETUP, indentWithTab: false, theme: "dark" }), ...extra],
    }),
  });
  startCompletion(view);
  for (let i = 0; i < 50 && completionStatus(view.state) !== "active"; i++) await new Promise((r) => setTimeout(r, 20));
  const first = currentCompletions(view.state)[0]?.label;
  // CodeMirror ignores accept keys for interactionDelay (75 ms) after the list opens; a person is slower.
  await new Promise((r) => setTimeout(r, 120));
  const ev = new (win as any).KeyboardEvent("keydown", { key, keyCode: key === "Enter" ? 13 : 9 });
  runScopeHandlers(view, ev, "editor");
  const out = { status: completionStatus(view.state), first, doc: view.state.doc.toString() };
  view.destroy();
  return out;
}

let failed = 0;
const expect = (name: string, ok: boolean, detail: unknown) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`, ok ? "" : JSON.stringify(detail));
  if (!ok) failed++;
};

for (const key of ["Enter", "Tab"] as const) {
  const r = await press(editorExtensions(env, () => {}), key);
  expect(`${key} with the list open accepts "${r.first}"`, !!r.first && r.doc.startsWith(`load token\n${r.first}`) && r.doc.split("\n").length === 2, r);
}
// Control: the previous ordering (no precedence) loses Enter to basicSetup's newline.
const old = await press([keymap.of([{ key: "Tab", run: acceptCompletion }, ...completionKeymap])], "Enter");
expect("control: without precedence, Enter inserts a newline (the reported bug)", old.doc.startsWith("load token\ntoken:\n"), old);
// Enter with no list open is still a newline.
{
  const parent = document.createElement("div");
  const view = new EditorView({
    parent: parent as any,
    state: EditorState.create({ doc: "load token", selection: { anchor: 10 }, extensions: [...getDefaultExtensions({ basicSetup: BASIC_SETUP, indentWithTab: false, theme: "dark" }), ...editorExtensions(env, () => {})] }),
  });
  runScopeHandlers(view, new (win as any).KeyboardEvent("keydown", { key: "Enter", keyCode: 13 }), "editor");
  expect("Enter without a list still starts a new line", view.state.doc.toString() === "load token\n", view.state.doc.toString());
}
void Prec;
process.exit(failed ? 1 : 0);
