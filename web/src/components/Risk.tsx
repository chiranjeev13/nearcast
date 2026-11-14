import type { Risk, Snapshot } from "@api";

const STYLE: Record<Risk, string> = {
  "read-only": "text-dim",
  "state-changing": "text-warn",
  irreversible: "text-bad",
  "high-value": "text-bad font-bold",
};

export function RiskTag({ r }: { r: Risk }) {
  return <span className={`text-[10.5px] font-mono whitespace-nowrap ${STYLE[r]}`}>[{r.toUpperCase()}]</span>;
}

export function modeOf(snap: Snapshot): "SIMULATE-ONLY" | "EXECUTING" | "DONE" | "STOPPED" {
  if (snap.running || snap.walletRequest) return "EXECUTING";
  if (snap.run === "complete") return "DONE";
  if (snap.run === "unfinished") return "STOPPED";
  return "SIMULATE-ONLY";
}
