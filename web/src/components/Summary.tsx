import type { PlanView } from "@api";
import { short } from "./ui.tsx";

export function Summary({ v }: { v: PlanView }) {
  const cells: [string, string, string?][] = [
    ["Network", `NEAR ${v.network}`, v.network === "mainnet" ? "text-warn" : undefined],
    ["From", short(v.account, 8)],
    ["Total", `${v.txCount} transaction${v.txCount === 1 ? "" : "s"}${v.chainCount > 1 ? ` · ${v.chainCount} chains` : ""}`],
  ];
  return (
    <div className="grid grid-cols-3 border border-line-2 rounded-[3px] divide-x divide-line-2">
      {cells.map(([k, val, cls]) => (
        <div key={k} className="px-4 py-3 min-w-0">
          <div className="text-dim text-[12px]">{k}</div>
          <div className={`mt-1 truncate ${cls ?? ""}`} title={k === "From" ? v.account : undefined}>{val}</div>
        </div>
      ))}
    </div>
  );
}

const MARK = { ok: ["✓", "text-accent"], warn: ["!", "text-warn"], fail: ["×", "text-bad"] } as const;

export function Checks({ v }: { v: PlanView }) {
  if (!v.checks.length && !v.problems.length) return null;
  const fails = new Set(v.checks.filter((c) => c.level === "fail").map((c) => c.description));
  const extra = v.problems.filter((p) => !fails.has(p));
  return (
    <div className="flex flex-col gap-1 text-[12px]">
      {v.checks.map((c, i) => (
        <div key={i} className="flex gap-2">
          <span className={`${MARK[c.level][1]} w-3 shrink-0`}>{MARK[c.level][0]}</span>
          <span className={c.level === "ok" ? "text-dim" : ""}>{c.description}</span>
        </div>
      ))}
      {extra.map((p, i) => (
        <div key={`p${i}`} className="flex gap-2">
          <span className="text-bad w-3 shrink-0">×</span>
          <span>{p}</span>
        </div>
      ))}
    </div>
  );
}
