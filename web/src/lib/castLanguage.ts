import { HighlightStyle, StreamLanguage, syntaxHighlighting, type StreamParser } from "@codemirror/language";
import { RangeSet, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, gutterLineClass, type DecorationSet } from "@codemirror/view";
import { Tag, tags as t } from "@lezer/highlight";

const KEYWORDS = new Set(["load", "set", "print", "assert"]);

export const castTags = {
  command: Tag.define(),
  helper: Tag.define(),
  option: Tag.define(),
  address: Tag.define(),
};

interface State {
  /** The next word is the head of a statement (first word on its line). */
  head: boolean;
}

const parser: StreamParser<State> = {
  name: "cast",
  startState: () => ({ head: true }),
  token(stream, state) {
    if (stream.sol()) state.head = true;
    if (stream.eatSpace()) return null;
    if (stream.peek() === "#") {
      stream.skipToEnd();
      return "comment";
    }
    const wasHead = state.head;
    state.head = false;

    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string";
    if (stream.match(/^\$[A-Za-z_][\w]*/)) return "variableName";
    if (stream.match(/^@[A-Za-z][\w-]*(?::[A-Za-z][\w-]*)?/)) return "helper";
    if (stream.match(/^--[A-Za-z][\w-]*/)) return "option";
    if (stream.match(/^(?:>=|<=|==|!=|>|<)/)) return "operator";
    if (stream.match(/^[()[\]{},]/)) {
      return "bracket";
    }
    if (stream.match(/^0x[0-9a-fA-F]+(?![\w.])/)) return "address";
    if (stream.match(/^\d+(?:\.\d+)?(?:e\d+)?(?:near|yocto|tgas)?(?![\w.:-])/)) return "number";
    if (stream.match(/^[A-Za-z0-9_][\w.-]*(?::[A-Za-z][\w-]*)?/)) {
      const w = stream.current();
      if (wasHead) return KEYWORDS.has(w) ? "keyword" : "command";
      if (w === "true" || w === "false" || w === "null") return "atom";
      return null;
    }
    stream.next();
    return null;
  },
  tokenTable: {
    command: castTags.command,
    helper: castTags.helper,
    option: castTags.option,
    address: castTags.address,
  },
  languageData: { commentTokens: { line: "#" } },
};

export const castLanguage = StreamLanguage.define(parser);

const style = HighlightStyle.define([
  { tag: t.comment, color: "#5d625d", fontStyle: "italic" },
  { tag: t.keyword, color: "#7dff63", fontWeight: "500" },
  { tag: castTags.command, color: "#39ff14", fontWeight: "500" },
  { tag: castTags.helper, color: "#c49bff" },
  { tag: t.variableName, color: "#7fa8ff" },
  { tag: t.string, color: "#e8c46a" },
  { tag: t.number, color: "#ff9e64" },
  { tag: castTags.option, color: "#6fd3d6" },
  { tag: castTags.address, color: "#d7dad5" },
  { tag: t.atom, color: "#ff9e64" },
  { tag: t.operator, color: "#e6e9e4" },
  { tag: t.bracket, color: "#9aa09a" },
]);

// ---------------------------------------------------------------- error line marker

export const setErrorLine = StateEffect.define<number | null>();

const errorMark = Decoration.line({ class: "cm-errorLine" });
class ErrorGutter extends GutterMarker {
  elementClass = "cm-errorLine-gutter";
}
const errorGutterMarker = new ErrorGutter();

const errorField = StateField.define<{ line: number | null; deco: DecorationSet }>({
  create: () => ({ line: null, deco: Decoration.none }),
  update(value, tr) {
    let line = value.line;
    for (const e of tr.effects) if (e.is(setErrorLine)) line = e.value;
    // Any edit clears the marker: the message described the old text.
    if (tr.docChanged && !tr.effects.some((e) => e.is(setErrorLine))) line = null;
    if (line === value.line && !tr.docChanged) return value;
    if (line === null || line < 1 || line > tr.state.doc.lines) return { line: null, deco: Decoration.none };
    const from = tr.state.doc.line(line).from;
    return { line, deco: Decoration.set([errorMark.range(from)]) };
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.deco),
    gutterLineClass.from(f, (v) => {
      const out: number[] = [];
      v.deco.between(0, Number.MAX_SAFE_INTEGER, (from) => {
        out.push(from);
      });
      return RangeSet.of(out.map((from) => errorGutterMarker.range(from)));
    }),
  ],
});

export function castSupport(): Extension {
  return [castLanguage, syntaxHighlighting(style), errorField];
}
