import type { Plan } from "./types.js";

/** Reasons a plan must not run: failed preflight checks and failed funding checks. */
export function planProblems(plan: Plan): string[] {
  const out: string[] = [];
  for (const s of plan.steps) {
    if (s.type === "assert" && s.phase === "preflight" && !s.planResult.ok) {
      out.push(`line ${s.source.line}: ${s.message ?? s.source.text} (${s.planResult.detail} is false)`);
    }
  }
  for (const c of plan.checks) if (c.level === "fail") out.push(c.description);
  return out;
}
