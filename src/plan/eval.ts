import type { Env, EvmChain } from "../env.js";
import type { CmpOp, Expr } from "../lang/ast.js";
import { ScriptError } from "../lang/ast.js";
import { NEAR, TGAS } from "../registry.js";
import type { Module } from "../modules/types.js";
import { isDecimal, type Value } from "./types.js";

export interface EvalCtx {
  env: Env;
  vars: Map<string, Value>;
  modules: Map<string, Module>;
  /** Set while inside `chainsig:on <chain> <path> ( ... )`. */
  evm?: { chain: EvmChain; path: string; sender: `0x${string}` };
}

const UNIT: Record<string, bigint> = { near: NEAR, tgas: TGAS, yocto: 1n };

export async function evalExpr(ctx: EvalCtx, e: Expr): Promise<Value> {
  switch (e.kind) {
    case "num": {
      let digits = e.digits * (e.unit ? UNIT[e.unit] : 1n);
      let exp = e.exp;
      if (exp >= 0) return digits * 10n ** BigInt(exp);
      while (exp < 0 && digits % 10n === 0n) {
        digits /= 10n;
        exp++;
      }
      if (exp === 0) return digits;
      if (e.unit) throw new ScriptError(`${e.raw} is not a whole number of base units`, e.loc);
      return { $decimal: { digits, exp } };
    }
    case "str":
      return e.value;
    case "word":
      if (e.value === "true") return true;
      if (e.value === "false") return false;
      if (e.value === "null") return null;
      return e.value;
    case "var": {
      if (!ctx.vars.has(e.name)) throw new ScriptError(`$${e.name} is not set`, e.loc);
      return ctx.vars.get(e.name)!;
    }
    case "array":
      return Promise.all(e.items.map((i) => evalExpr(ctx, i)));
    case "object": {
      const out: Record<string, Value> = {};
      for (const { key, value } of e.entries) out[key] = await evalExpr(ctx, value);
      return out;
    }
    case "helper": {
      const modName = e.module ?? "std";
      const mod = ctx.modules.get(modName);
      if (!mod) throw new ScriptError(`module "${modName}" is not loaded (add: load ${modName})`, e.loc);
      const fn = mod.helpers[e.name];
      if (!fn) {
        const full = e.module ? `@${e.module}:${e.name}` : `@${e.name}`;
        throw new ScriptError(`unknown helper ${full}`, e.loc);
      }
      const args: Value[] = [];
      for (const a of e.args) args.push(await evalExpr(ctx, a));
      try {
        return await fn(ctx, args, e);
      } catch (err) {
        if (err instanceof ScriptError && err.loc) throw err;
        throw new ScriptError((err as Error).message, e.loc);
      }
    }
  }
}

export function show(v: Value): string {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string") return v;
  if (v === null || typeof v === "boolean") return String(v);
  if (isDecimal(v)) return decimalString(v.$decimal.digits, v.$decimal.exp);
  if (Array.isArray(v)) return `[${v.map(show).join(", ")}]`;
  return `{${Object.entries(v).map(([k, x]) => `${k}: ${show(x)}`).join(", ")}}`;
}

function decimalString(digits: bigint, exp: number): string {
  const s = digits.toString().padStart(-exp + 1, "0");
  return `${s.slice(0, s.length + exp)}.${s.slice(exp)}`;
}

/** Value -> plain JSON for NEAR call arguments. Big integers become strings (the NEAR U128 convention). */
export function toJson(v: Value): unknown {
  if (typeof v === "bigint") return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= -BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
  if (isDecimal(v)) throw new Error(`fractional number ${show(v)} cannot be used as a call argument; quote it or use whole units`);
  if (Array.isArray(v)) return v.map(toJson);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toJson(x)]));
  return v;
}

/** Integer in base units, or throw. Numeric strings (as NEAR views return them) are accepted. */
export function asInt(v: Value, what: string): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  throw new Error(`${what} must be a whole number, got ${show(v)}`);
}

export function asString(v: Value, what: string): string {
  if (typeof v === "string") return v;
  throw new Error(`${what} must be text, got ${show(v)}`);
}

/** Scale a human amount ("1", "1.5") to base units; refuses amounts finer than the token allows. */
export function scale(v: Value, decimals: number, what: string): bigint {
  if (typeof v === "bigint") return v * 10n ** BigInt(decimals);
  if (typeof v === "string" && /^\d+(\.\d+)?$/.test(v)) {
    const [i, f = ""] = v.split(".");
    v = { $decimal: { digits: BigInt(i + f), exp: -f.length } };
  }
  if (isDecimal(v)) {
    const shift = decimals + v.$decimal.exp;
    if (shift < 0) throw new Error(`${what} ${show(v)} has more than ${decimals} decimal places`);
    return v.$decimal.digits * 10n ** BigInt(shift);
  }
  throw new Error(`${what} must be a number, got ${show(v)}`);
}

function numeric(v: Value): { digits: bigint; exp: number } | null {
  if (typeof v === "bigint") return { digits: v, exp: 0 };
  if (isDecimal(v)) return v.$decimal;
  if (typeof v === "string" && /^\d+$/.test(v)) return { digits: BigInt(v), exp: 0 };
  return null;
}

export function compare(l: Value, op: CmpOp, r: Value): boolean {
  const a = numeric(l);
  const b = numeric(r);
  if (a && b) {
    const e = Math.min(a.exp, b.exp);
    const x = a.digits * 10n ** BigInt(a.exp - e);
    const y = b.digits * 10n ** BigInt(b.exp - e);
    return { ">": x > y, ">=": x >= y, "<": x < y, "<=": x <= y, "==": x === y, "!=": x !== y }[op];
  }
  if (op === "==" || op === "!=") {
    const same = typeof l === "string" && typeof r === "string" ? l.toLowerCase() === r.toLowerCase() : show(l) === show(r);
    return op === "==" ? same : !same;
  }
  throw new Error(`cannot compare ${show(l)} ${op} ${show(r)}: both sides must be numbers`);
}

export async function evalAssert(
  ctx: EvalCtx,
  a: { left: Expr; op: CmpOp; right: Expr },
): Promise<{ ok: boolean; detail: string }> {
  const l = await evalExpr(ctx, a.left);
  const r = await evalExpr(ctx, a.right);
  return { ok: compare(l, a.op, r), detail: `${show(l)} ${a.op} ${show(r)}` };
}
