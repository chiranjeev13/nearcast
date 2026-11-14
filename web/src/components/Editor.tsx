import MonacoEditor from "@monaco-editor/react";
import { useEffect, useRef } from "react";
import type { Docs } from "@api";
import type { CompletionEnv } from "../lib/completions.ts";
import { LANG, monaco, setupMonaco, THEME, toMonacoSnippet } from "../lib/monaco.ts";

export interface Marker {
  line: number;
  message: string;
  severity: "error" | "warning";
}

/** What the rest of the app may do to the editor. */
export interface EditorApi {
  /** Insert a CodeMirror-style template (`${name}` fields) at the cursor line, or an example as plain text. */
  insert(text: string, asSnippet: boolean): void;
  reveal(line: number): void;
  focus(): void;
}

export function Editor({ value, onChange, docs, network, markers, onApi, onRun, onCursor, onSave }: {
  onSave: () => void;
  value: string;
  onChange: (v: string) => void;
  docs: Docs | null;
  network: string;
  markers: Marker[];
  onApi: (api: EditorApi | null) => void;
  onRun: () => void;
  onCursor: (line: number, col: number) => void;
}) {
  // Providers read the latest docs/network without re-registering.
  const envRef = useRef<CompletionEnv>({ docs, network });
  envRef.current = { docs, network };
  const runRef = useRef(onRun);
  runRef.current = onRun;
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  setupMonaco(() => envRef.current);

  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    monaco.editor.setModelMarkers(
      model,
      "nearcast",
      markers
        .filter((m) => m.line >= 1 && m.line <= model.getLineCount())
        .map((m) => ({
          startLineNumber: m.line,
          endLineNumber: m.line,
          startColumn: model.getLineFirstNonWhitespaceColumn(m.line) || 1,
          endColumn: model.getLineMaxColumn(m.line),
          message: m.message,
          severity: m.severity === "error" ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
        })),
    );
  }, [markers]);

  return (
    <MonacoEditor
      height="100%"
      language={LANG}
      theme={THEME}
      value={value}
      onChange={(v) => onChange(v ?? "")}
      options={{
        fontFamily: 'Menlo, Monaco, "Cascadia Code", Consolas, "Courier New", monospace',
        fontSize: 13,
        lineHeight: 20,
        minimap: { enabled: true, renderCharacters: false, scale: 1 },
        scrollBeyondLastLine: false,
        renderLineHighlight: "all",
        smoothScrolling: true,
        cursorBlinking: "smooth",
        cursorSmoothCaretAnimation: "on",
        padding: { top: 8 },
        tabSize: 2,
        wordWrap: "off",
        suggest: { showStatusBar: true, preview: true, insertMode: "replace" },
        quickSuggestions: { other: true, comments: false, strings: false },
        suggestOnTriggerCharacters: true,
        acceptSuggestionOnEnter: "on",
        fixedOverflowWidgets: true,
        stickyScroll: { enabled: false },
        automaticLayout: true,
      }}
      onMount={(editor) => {
        editorRef.current = editor;
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runRef.current());
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current());
        editor.onDidChangeCursorPosition((e) => onCursor(e.position.lineNumber, e.position.column));
        onApi({
          insert(text, asSnippet) {
            const pos = editor.getPosition() ?? new monaco.Position(1, 1);
            const model = editor.getModel()!;
            const line = model.getLineContent(pos.lineNumber);
            const empty = line.trim() === "";
            const at = empty ? new monaco.Position(pos.lineNumber, 1) : new monaco.Position(pos.lineNumber, line.length + 1);
            editor.setSelection(new monaco.Selection(at.lineNumber, empty ? 1 : at.column, at.lineNumber, empty ? line.length + 1 : at.column));
            const prefix = empty ? "" : "\n";
            if (asSnippet) {
              (editor.getContribution("snippetController2") as any)?.insert(prefix + toMonacoSnippet(text));
            } else {
              editor.executeEdits("insert", [{ range: editor.getSelection()!, text: prefix + text }]);
            }
            editor.focus();
          },
          reveal(line) {
            editor.revealLineInCenter(line);
            editor.setPosition(new monaco.Position(line, 1));
            editor.focus();
          },
          focus: () => editor.focus(),
        });
      }}
    />
  );
}
