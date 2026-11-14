import type { StepView } from "@api";
import { RiskTag } from "./Risk.tsx";
import { Copy, Value, short } from "./ui.tsx";

const STATUS: Record<StepView["status"], { label: string; cls: string }> = {
  planned: { label: "", cls: "" },
  signed: { label: "signed", cls: "text-warn" },
  broadcast: { label: "sent", cls: "text-warn" },
  confirmed: { label: "confirmed", cls: "text-accent" },
  failed: { label: "failed", cls: "text-bad" },
};

export function StepCard({ s, showStatus, active }: { s: StepView; showStatus: boolean; active?: boolean }) {
  const st = STATUS[s.status];
  const check = s.kind === "check";
  return (
    <div className="flex gap-3">
      <div className={`w-5 pt-3 text-right shrink-0 font-mono ${s.status === "failed" ? "text-bad" : "text-accent"}`}>{s.n}</div>
      <div className={`flex-1 min-w-0 border rounded-md px-4 py-3 bg-panel ${active ? "border-accent/60" : "border-line"}`}>
        <div className="flex items-baseline gap-3">
          <div className={`font-bold flex-1 min-w-0 ${check ? "text-dim font-normal" : ""}`}>{s.title}</div>
          <div className="text-dim text-[11px] shrink-0">{s.chain}{s.signedWith === "wallet" ? " · wallet" : ""}</div>
        </div>
        {s.risk?.length > 0 && (
          <div className="flex gap-2 flex-wrap mt-1">{s.risk.map((r) => <RiskTag key={r} r={r} />)}</div>
        )}
        {s.danger && <div className="text-bad mt-2 text-[12px]">! {s.danger}</div>}
        {s.rows.length > 0 && (
          <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
            {s.rows.map(([k, v], i) => (
              <div key={i} className="contents">
                <div className="text-dim">{k}</div>
                <div className="min-w-0"><Value text={v} /></div>
              </div>
            ))}
          </div>
        )}
        {s.actions.length > 0 && (
          <div className="mt-2 text-[11.5px] font-mono border-l border-line-2 pl-3 flex flex-col gap-1">
            {s.atomic && <div className="text-dim text-[11px]">atomic · {s.actions.length} actions</div>}
            {s.actions.map((a, i) => <div key={i} className="break-all">{a}</div>)}
          </div>
        )}
        {(showStatus && st.label) || s.txHash || s.error || s.result || s.hint ? (
          <div className="mt-2 pt-2 border-t border-line text-[12px] flex flex-col gap-1">
            {showStatus && st.label && (
              <div className="flex gap-3">
                <span className={st.cls}>{st.label}</span>
                {s.fee && <span className="text-dim">fee {s.fee}</span>}
              </div>
            )}
            {s.txHash && (
              <div className="flex items-center min-w-0">
                <span className="text-dim mr-2">tx</span>
                {s.url ? (
                  <a className="underline decoration-line-2 hover:text-accent truncate" href={s.url} target="_blank" rel="noreferrer">{short(s.txHash, 10)}</a>
                ) : (
                  <span className="truncate">{short(s.txHash, 10)}</span>
                )}
                <Copy text={s.txHash} />
              </div>
            )}
            {s.result && <div className="text-dim break-all">{s.result}</div>}
            {s.error && <div className="text-bad break-all">{s.error}</div>}
            {s.hint && s.hint.split("\n").filter(Boolean).map((h, i) => (
              <div key={i} className="text-text break-words"><span className="text-accent">→ </span>{h}</div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
