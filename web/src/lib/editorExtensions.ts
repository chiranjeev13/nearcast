import { acceptCompletion, autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { indentWithTab } from "@codemirror/commands";
import { Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import type { BasicSetupOptions } from "@uiw/react-codemirror";
import { castSupport } from "./castLanguage.ts";
import { castCompletions, type CompletionEnv } from "./completions.ts";

/** basicSetup for the editor. Its own autocompletion and keymaps are off: ours are below. */
export const BASIC_SETUP: BasicSetupOptions = {
  lineNumbers: true,
  foldGutter: false,
  highlightActiveLine: true,
  highlightActiveLineGutter: true,
  autocompletion: false,
  bracketMatching: true,
  closeBrackets: true,
  indentOnInput: false,
  searchKeymap: true,
  completionKeymap: false,
};

export function editorExtensions(env: () => CompletionEnv, onRun: () => void): Extension[] {
  return [
    castSupport(),
    autocompletion({
      override: [castCompletions(env)],
      activateOnTyping: true,
      closeOnBlur: true,
      icons: true,
      maxRenderedOptions: 80,
      defaultKeymap: false,
    }),
    // Highest precedence: basicSetup's default keymap (Enter = newline, Tab = indent) is installed
    // before these extensions and would otherwise win while the suggestion list is open.
    // completionKeymap's Enter/Tab only act when the list is open, so typing is unaffected.
    Prec.highest(
      keymap.of([
        { key: "Mod-Enter", run: () => (onRun(), true) },
        { key: "Tab", run: acceptCompletion },
        ...completionKeymap,
      ]),
    ),
    keymap.of([indentWithTab]),
    EditorView.lineWrapping,
  ];
}
