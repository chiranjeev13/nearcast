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

const MODE_CLS = { "SIMULATE-ONLY": "text-dim", EXECUTING: "text-accent", DONE: "text-accent", STOPPED: "text-warn" } as const;

/** `Mode: SIMULATE-ONLY | Network: testnet | Risk: [STATE-CHANGING]` */
export function ModeLine({ snap }: { snap: Snapshot }) {
  const v = snap.view!;
  const mode = modeOf(snap);
  return (
    <div className="text-[11.5px] font-mono whitespace-nowrap overflow-hidden text-ellipsis">
      <span className="text-faint">Mode: </span><span className={MODE_CLS[mode]}>{mode}</span>
      <span className="text-faint"> | Network: </span><span className={v.network === "mainnet" ? "text-bad font-bold" : ""}>{v.network}</span>
      <span className="text-faint"> | Risk: </span><RiskTag r={v.risk} />
    </div>
  );
}
