import { createToken, EmbeddedActionsParser, type IToken, Lexer } from "chevrotain";
import type { CmpOp, CommandStmt, Expr, Loc, Stmt, Unit } from "./ast.js";
import { ScriptError } from "./ast.js";

// ---- tokens -------------------------------------------------------------------------------

const WORD_CHARS = "A-Za-z0-9_.\\-";
const Newline = createToken({ name: "Newline", pattern: /\r?\n/ });
const WS = createToken({ name: "WS", pattern: /[ \t]+/, group: Lexer.SKIPPED });
const Comment = createToken({ name: "Comment", pattern: /#[^\n]*/, group: Lexer.SKIPPED });
const LParen = createToken({ name: "LParen", pattern: /\(/ });
const RParen = createToken({ name: "RParen", pattern: /\)/ });
const LBrace = createToken({ name: "LBrace", pattern: /\{/ });
const RBrace = createToken({ name: "RBrace", pattern: /\}/ });
const LBracket = createToken({ name: "LBracket", pattern: /\[/ });
const RBracket = createToken({ name: "RBracket", pattern: /\]/ });
const Comma = createToken({ name: "Comma", pattern: /,/ });
const Colon = createToken({ name: "Colon", pattern: /:/ });
const Cmp = createToken({ name: "Cmp", pattern: />=|<=|==|!=|>|</ });
const Opt = createToken({ name: "Opt", pattern: /--[A-Za-z][A-Za-z0-9\-]*/ });
const Var = createToken({ name: "Var", pattern: /\$[A-Za-z_][A-Za-z0-9_]*/ });
const Helper = createToken({ name: "Helper", pattern: /@[A-Za-z][A-Za-z0-9_\-]*(:[A-Za-z][A-Za-z0-9_\-]*)?/ });
const Str = createToken({ name: "Str", pattern: /"(?:[^"\\\n]|\\.)*"/ });
// A number only if the whole word is numeric: `3e2210e1184b…` (an account id) must stay a word.
const Num = createToken({
  name: "Num",
  pattern: new RegExp(`\\d+(?:\\.\\d+)?(?:e\\d+)?(?:near|yocto|tgas)?(?![${WORD_CHARS}:])`),
});
// A file path: ./x.wasm, ../build/x.wasm, /abs/x.wasm. Evaluates like a word.
const Path = createToken({ name: "Path", pattern: /(?:\.\.?\/|\/)[^\s()"#,\[\]{}]+/ });
// Words cover account ids, 0x addresses, symbols and `module:command` names.
const Word = createToken({
  name: "Word",
  pattern: new RegExp(`[A-Za-z0-9_][${WORD_CHARS}]*(?::[A-Za-z0-9][A-Za-z0-9_\\-]*)?`),
});

const tokens = [
  Newline, WS, Comment, LParen, RParen, LBrace, RBrace, LBracket, RBracket, Comma,
  Cmp, Opt, Var, Helper, Str, Num, Path, Word, Colon,
];
const lexer = new Lexer(tokens, { positionTracking: "full" });

// ---- generic line shape, typed afterwards -------------------------------------------------

type Item =
  | { t: "expr"; expr: Expr }
  | { t: "opt"; name: string; value: Expr; loc: Loc }
  | { t: "cmp"; op: CmpOp; loc: Loc }
  | { t: "block"; body: RawStmt[]; loc: Loc };
interface RawStmt {
  head: string;
  loc: Loc;
  items: Item[];
}

const locOf = (t: IToken): Loc => ({ line: t.startLine ?? 0, col: t.startColumn ?? 0 });

function parseNumber(image: string, loc: Loc): Expr {
  const m = /^(\d+)(?:\.(\d+))?(?:e(\d+))?(near|yocto|tgas)?$/.exec(image);
  if (!m) throw new ScriptError(`bad number "${image}"`, loc);
  const frac = m[2] ?? "";
  return {
    kind: "num",
    raw: image,
    digits: BigInt(m[1] + frac),
    exp: Number(m[3] ?? 0) - frac.length,
    unit: m[4] as Unit | undefined,
    loc,
  };
}

class NcrParser extends EmbeddedActionsParser {
  constructor() {
    super(tokens, { recoveryEnabled: false });
    this.performSelfAnalysis();
  }

  script = this.RULE("script", (): RawStmt[] => {
    const out: RawStmt[] = [];
    this.MANY(() => {
      this.OR([
        { ALT: () => this.CONSUME(Newline) },
        { ALT: () => out.push(this.SUBRULE(this.statement)) },
      ]);
    });
    return out;
  });

  statement = this.RULE("statement", (): RawStmt => {
    const head = this.CONSUME(Word);
    const items: Item[] = [];
    this.MANY(() => items.push(this.SUBRULE(this.item)));
    // A statement ends at a newline, at end of input, or right before the `)` closing a block.
    this.OPTION(() => this.CONSUME(Newline));
    return { head: head.image, loc: locOf(head), items };
  });

  item = this.RULE("item", (): Item =>
    this.OR([
      {
        ALT: () => {
          const o = this.CONSUME(Opt);
          const value = this.SUBRULE(this.expr);
          return { t: "opt" as const, name: o.image.slice(2), value, loc: locOf(o) };
        },
      },
      {
        ALT: () => {
          const c = this.CONSUME(Cmp);
          return { t: "cmp" as const, op: c.image as CmpOp, loc: locOf(c) };
        },
      },
      {
        ALT: () => {
          const p = this.CONSUME(LParen);
          const body: RawStmt[] = [];
          this.MANY(() => {
            this.OR2([
              { ALT: () => this.CONSUME(Newline) },
              { ALT: () => body.push(this.SUBRULE(this.statement)) },
            ]);
          });
          this.CONSUME(RParen);
          return { t: "block" as const, body, loc: locOf(p) };
        },
      },
      { ALT: () => ({ t: "expr" as const, expr: this.SUBRULE2(this.expr) }) },
    ]),
  );

  expr = this.RULE("expr", (): Expr =>
    this.OR([
      {
        ALT: () => {
          const t = this.CONSUME(Num);
          return this.ACTION(() => parseNumber(t.image, locOf(t)));
        },
      },
      {
        ALT: () => {
          const t = this.CONSUME(Str);
          return this.ACTION(() => ({ kind: "str" as const, value: JSON.parse(t.image) as string, loc: locOf(t) }));
        },
      },
      {
        ALT: () => {
          const t = this.CONSUME(Var);
          return { kind: "var" as const, name: t.image.slice(1), loc: locOf(t) };
        },
      },
      {
        ALT: () => {
          const t = this.CONSUME(Word);
          return { kind: "word" as const, value: t.image, loc: locOf(t) };
        },
      },
      {
        ALT: () => {
          const t = this.CONSUME(Path);
          return { kind: "word" as const, value: t.image, loc: locOf(t) };
        },
      },
      { ALT: () => this.SUBRULE(this.helper) },
      { ALT: () => this.SUBRULE(this.object) },
      { ALT: () => this.SUBRULE(this.array) },
    ]),
  );

  helper = this.RULE("helper", (): Expr => {
    const h = this.CONSUME(Helper);
    const args: Expr[] = [];
    // `@name(` takes arguments only when the paren touches the name; `@me (` is a helper then a block.
    this.OPTION({
      GATE: () => this.LA(1).tokenType === LParen && this.LA(1).startOffset === (h.endOffset ?? -2) + 1,
      DEF: () => {
        this.CONSUME(LParen);
        this.MANY(() => args.push(this.SUBRULE(this.expr)));
        this.CONSUME(RParen);
      },
    });
    const [a, b] = h.image.slice(1).split(":");
    return { kind: "helper", module: b ? a : undefined, name: b ?? a, args, loc: locOf(h) };
  });

  object = this.RULE("object", (): Expr => {
    const l = this.CONSUME(LBrace);
    const entries: { key: string; value: Expr }[] = [];
    this.MANY_SEP({
      SEP: Comma,
      DEF: () => {
        const k = this.CONSUME(Str);
        this.CONSUME(Colon);
        const value = this.SUBRULE(this.expr);
        this.ACTION(() => entries.push({ key: JSON.parse(k.image), value }));
      },
    });
    this.CONSUME(RBrace);
    return { kind: "object", entries, loc: locOf(l) };
  });

  array = this.RULE("array", (): Expr => {
    const l = this.CONSUME(LBracket);
    const items: Expr[] = [];
    this.MANY_SEP({ SEP: Comma, DEF: () => items.push(this.SUBRULE(this.expr)) });
    this.CONSUME(RBracket);
    return { kind: "array", items, loc: locOf(l) };
  });
}

const parser = new NcrParser();

// ---- typing pass --------------------------------------------------------------------------

const KEYWORDS = new Set(["load", "set", "print", "assert"]);

function shape(raw: RawStmt, lines: string[]): Stmt {
  const { head, loc, items } = raw;
  const text = (lines[loc.line - 1] ?? "").trim();
  const exprs = (): Expr[] =>
    items.map((i) => {
      if (i.t !== "expr") {
        const what = i.t === "opt" ? `option --${i.name}` : i.t === "cmp" ? `"${i.op}"` : "a block";
        throw new ScriptError(`"${head}" does not take ${what}`, i.loc);
      }
      return i.expr;
    });

  if (head === "load") {
    const a = exprs();
    if (a.length !== 1 || a[0].kind !== "word") throw new ScriptError('usage: load <module>', loc);
    return { kind: "load", module: a[0].value, loc, text };
  }
  if (head === "set") {
    const a = exprs();
    if (a.length !== 2 || a[0].kind !== "var") throw new ScriptError("usage: set $name <value>", loc);
    return { kind: "set", name: a[0].name, value: a[1], loc, text };
  }
  if (head === "print") return { kind: "print", args: exprs(), loc, text };
  if (head === "assert") {
    const [l, c, r, m, ...rest] = items;
    const ok = l?.t === "expr" && c?.t === "cmp" && r?.t === "expr" && rest.length === 0 &&
      (m === undefined || (m.t === "expr" && m.expr.kind === "str"));
    if (!ok) throw new ScriptError('usage: assert <left> <op> <right> ["message"]   (op: > >= < <= == !=)', loc);
    return {
      kind: "assert",
      left: (l as any).expr,
      op: (c as any).op,
      right: (r as any).expr,
      message: m ? (m as any).expr.value : undefined,
      loc,
      text,
    };
  }

  const m = /^(?:([A-Za-z][A-Za-z0-9_\-]*):)?([A-Za-z][A-Za-z0-9_\-]*)$/.exec(head);
  if (!m) throw new ScriptError(`expected a command, got "${head}"`, loc);
  const cmd: CommandStmt = { kind: "command", module: m[1], name: m[2], args: [], opts: {}, loc, text };
  for (const i of items) {
    if (i.t === "expr") {
      if (cmd.block) throw new ScriptError("nothing may follow a block", i.expr.loc);
      cmd.args.push(i.expr);
    } else if (i.t === "opt") {
      if (i.name in cmd.opts) throw new ScriptError(`option --${i.name} given twice`, i.loc);
      cmd.opts[i.name] = i.value;
    } else if (i.t === "block") {
      if (cmd.block) throw new ScriptError("a command takes at most one block", i.loc);
      cmd.block = i.body.map((s) => shape(s, lines));
    } else {
      throw new ScriptError(`comparison "${i.op}" is only allowed in assert`, i.loc);
    }
  }
  return cmd;
}

export function parse(source: string): Stmt[] {
  const lex = lexer.tokenize(source);
  if (lex.errors.length) {
    const e = lex.errors[0];
    throw new ScriptError(`unexpected character "${source[e.offset]}"`, { line: e.line ?? 0, col: e.column ?? 0 });
  }
  parser.input = lex.tokens;
  const raw = parser.script();
  if (parser.errors.length) {
    const e = parser.errors[0];
    const t = e.token;
    const at = Number.isNaN(t.startLine as number) || t.startLine === undefined
      ? { line: source.split("\n").length, col: 0 }
      : locOf(t);
    const got = t.image ? `"${t.image.replace(/\n/, "\\n")}"` : "end of script";
    throw new ScriptError(`syntax error at ${got} (unclosed "(" or stray token?)`, at);
  }
  const lines = source.split("\n");
  const out = raw.map((s) => shape(s, lines));
  void KEYWORDS;
  return out;
}
