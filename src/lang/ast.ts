export interface Loc {
  line: number;
  col: number;
}

export type Unit = "near" | "yocto" | "tgas";
export type CmpOp = ">" | ">=" | "<" | "<=" | "==" | "!=";

export type Expr =
  /** `digits`/`exp` keep the literal exact: value = digits * 10^exp. Fractions survive until a command decides. */
  | { kind: "num"; raw: string; digits: bigint; exp: number; unit?: Unit; loc: Loc }
  | { kind: "str"; value: string; loc: Loc }
  | { kind: "var"; name: string; loc: Loc }
  /** Bareword: account id, 0x address, token symbol, chain name, method name. */
  | { kind: "word"; value: string; loc: Loc }
  | { kind: "helper"; module?: string; name: string; args: Expr[]; loc: Loc }
  | { kind: "object"; entries: { key: string; value: Expr }[]; loc: Loc }
  | { kind: "array"; items: Expr[]; loc: Loc };

export type Stmt =
  | { kind: "load"; module: string; loc: Loc; text: string }
  | { kind: "set"; name: string; value: Expr; loc: Loc; text: string }
  | { kind: "print"; args: Expr[]; loc: Loc; text: string }
  | { kind: "assert"; left: Expr; op: CmpOp; right: Expr; message?: string; loc: Loc; text: string }
  | CommandStmt;

export interface CommandStmt {
  kind: "command";
  module?: string;
  name: string;
  args: Expr[];
  opts: Record<string, Expr>;
  block?: Stmt[];
  loc: Loc;
  text: string;
}

export class ScriptError extends Error {
  constructor(
    message: string,
    readonly loc?: Loc,
  ) {
    super(loc ? `line ${loc.line}: ${message}` : message);
  }
}
