import type { CommandStmt, Expr } from "../lang/ast.js";
import type { EvalCtx } from "../plan/eval.js";
import { asInt, scale } from "../plan/eval.js";
import type { PlanCtx } from "../plan/planner.js";
import type { Value } from "../plan/types.js";
import type { OptDoc } from "../ui/api.js";

/** A helper computes a value. It may read chain state; it never produces a step. */
export type HelperFn = (ctx: EvalCtx, args: Value[], node: Expr) => Promise<Value>;
/** A command adds steps to the plan through the context. It never signs or sends anything. */
export type CommandFn = (ctx: PlanCtx, cmd: CommandStmt) => Promise<void>;

/** Documentation for one command or helper. The docs pane, autocomplete and `nearcast docs` all read it. */
export interface Doc {
  usage: string;
  summary: string;
  details?: string;
  example?: string;
  opts?: OptDoc[];
  block?: boolean;
  chains?: string[];
}

export interface Module {
  name: string;
  summary: string;
  commands: Record<string, CommandFn>;
  helpers: Record<string, HelperFn>;
  /** Keyed by command name, and by "@name" for helpers. Every command and helper must have one. */
  docs: Record<string, Doc>;
}

export function arity(args: unknown[], min: number, max: number, usage: string): void {
  if (args.length < min || args.length > max) throw new Error(`usage: ${usage}`);
}

export function onlyOpts(cmd: CommandStmt, allowed: string[], name: string): void {
  for (const k of Object.keys(cmd.opts)) {
    if (!allowed.includes(k)) {
      throw new Error(`${name} has no option --${k}` + (allowed.length ? ` (options: ${allowed.map((a) => `--${a}`).join(", ")})` : ""));
    }
  }
}

const YOCTO = 24;

/**
 * A NEAR amount. A literal with a unit is exact (`1near`, `500yocto`); anything else is whole NEAR
 * (`1`, `0.25`, "2.5"). So `transfer bob.testnet 1` sends 1 NEAR, never 1 yoctoNEAR.
 */
export async function nearAmount(ctx: EvalCtx & { eval(e: Expr): Promise<Value> }, e: Expr, what: string): Promise<bigint> {
  const v = await ctx.eval(e);
  if (e.kind === "num" && e.unit) return asInt(v, what);
  return scale(v, YOCTO, what);
}
