import type { EditorView } from "@codemirror/view";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { useEffect, useMemo, useRef } from "react";
import type { Docs } from "@api";
import { setErrorLine } from "../lib/castLanguage.ts";
import type { CompletionEnv } from "../lib/completions.ts";
import { BASIC_SETUP, editorExtensions } from "../lib/editorExtensions.ts";

export function Editor({ value, onChange, docs, network, errorLine, onView, onRun }: {
  value: string;
  onChange: (v: string) => void;
  docs: Docs | null;
  network: string;
  errorLine: number | null;
  onView: (v: EditorView | null) => void;
  onRun: () => void;
}) {
  const ref = useRef<ReactCodeMirrorRef>(null);
  // The completion source reads the latest docs/network without rebuilding the editor.
  const envRef = useRef<CompletionEnv>({ docs, network });
  envRef.current = { docs, network };
  const runRef = useRef(onRun);
  runRef.current = onRun;

  const extensions = useMemo(() => editorExtensions(() => envRef.current, () => runRef.current()), []);

  useEffect(() => {
    const view = ref.current?.view;
    if (view) view.dispatch({ effects: setErrorLine.of(errorLine) });
  }, [errorLine]);

  return (
    <CodeMirror
      ref={ref}
      value={value}
      onChange={onChange}
      theme="dark"
      height="100%"
      className="h-full"
      extensions={extensions}
      indentWithTab={false}
      basicSetup={BASIC_SETUP}
      onCreateEditor={(view) => onView(view)}
    />
  );
}
