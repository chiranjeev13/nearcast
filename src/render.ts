import type { Checkpoint, Plan, StepState } from "./plan/types.js";
import { planProblems } from "./plan/problems.js";
import type { Risk, StepView } from "./ui/api.js";
import { planView } from "./ui/view.js";

export { planProblems };

const TAG: Record<Risk, string> = { "read-only": "[READ-ONLY]", "state-changing": "[STATE-CHANGING]", irreversible: "[IRREVERSIBLE]", "high-value": "[HIGH-VALUE]" };
const MARK = { ok: "ok  ", warn: "WARN", fail: "FAIL" } as const;
const STATUS: Record<string, string> = {
  planned: "not started",
  signed: "signed, not yet sent",
  broadcast: "sent, waiting for confirmation",
  confirmed: "confirmed",
  failed: "FAILED",
};

function stepLines(s: StepView, receipt: boolean): string[] {
  const n = `${s.n}.`.padEnd(4);
  const out = [`${n}[${s.chain}] ${s.title}  ${s.risk.map((r) => TAG[r]).join(" ")}`, `      line ${s.line}: ${s.text}`];
  if (receipt) {
    out.push(`      ${STATUS[s.status]}` + (s.error ? `: ${s.error}` : ""));
    if (s.hint) out.push(`      → next: ${s.hint}`);
    if (s.txHash && s.kind !== "check") out.push(`      tx ${s.txHash}`);
    if (s.url) out.push(`      ${s.url}`);
    if (s.fee) out.push(`      fee paid ${s.fee}`);
    if (s.result) out.push(`      ${s.kind === "local" ? "signed delegate (base64): " : ""}${s.result}`);
    return out;
  }
  for (const [k, v] of s.rows) out.push(`      ${k.padEnd(9)} ${v}`);
  if (s.actions.length) {
    if (s.atomic) out.push(`      ${s.actions.length} actions, ATOMIC: all succeed or none do`);
    for (const a of s.actions) out.push(`        - ${a}`);
  }
  if (s.danger) out.push(`      !! ${s.danger}`);
  if (s.signedWith === "wallet") out.push("      signed by the connected wallet");
  return out;
}

export function renderPlan(plan: Plan, file: string): string {
  const v = planView(plan);
  const out: string[] = [
    `Mode: SIMULATE-ONLY | Network: ${plan.network} | Risk: ${TAG[v.risk]}`,
    "",
    `Plan for ${file}`,
    `  account ${plan.account} on NEAR ${plan.network}`,
    `  script  ${plan.scriptHash.slice(0, 16)}`,
    "",
  ];
  for (const p of plan.prints) out.push(`  print: ${p}`);
  if (plan.prints.length) out.push("");
  out.push(`Steps (${v.steps.length}, run in this order)`, "");
  for (const s of v.steps) out.push(...stepLines(s, false), "");
  out.push("Simulated");
  for (const x of v.simulated) out.push(`  ✓ ${x}`);
  out.push("", "Funding checks");
  if (plan.checks.length === 0) out.push("  (none needed)");
  for (const c of plan.checks) out.push(`  ${MARK[c.level]} ${c.description}`);
  out.push(
    "",
    "Atomicity",
    `  ${v.txCount} transaction(s) on ${v.chainCount} chain(s). Each transaction is atomic on its own.`,
    "  The steps are NOT atomic with each other: if a later step fails, earlier steps stay done.",
    "",
    "Cost ceiling",
    `  ${v.cost}`,
  );
  if (v.problems.length) {
    out.push("", "BLOCKED: this plan cannot run yet");
    for (const p of v.problems) out.push(`  - ${p}`);
  }
  return out.join("\n");
}

export function renderReceipt(cp: Checkpoint): string {
  const { plan, state } = cp;
  const v = planView(plan, state);
  const out: string[] = [`Receipt for script ${plan.scriptHash.slice(0, 16)} (account ${plan.account}, NEAR ${plan.network})`, ""];
  for (const s of v.steps) out.push(...stepLines(s, true));
  const done = plan.steps.filter((s) => (state[s.id] as StepState | undefined)?.status === "confirmed").length;
  const failed = plan.steps.find((s) => state[s.id]?.status === "failed");
  out.push("");
  if (done === plan.steps.length) out.push("All steps confirmed.");
  else {
    out.push(`${done} of ${plan.steps.length} steps confirmed.` + (failed ? ` Stopped at step ${failed.index + 1}.` : ""));
    out.push("Nothing was rolled back: confirmed steps above are final on their chains.");
  }
  return out.join("\n");
}
