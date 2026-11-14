import { useEffect, useMemo, useState } from "react";
import type { Snapshot, StepView } from "@api";
import { ModeLine } from "./Risk.tsx";
import { StepCard } from "./StepCard.tsx";
import { Checks } from "./Summary.tsx";
import { Button } from "./ui.tsx";

export interface FlowActions {
  review: () => void;
  resume: (retryFailed: boolean) => void;
  kill: () => void;
  fresh: () => void;
  approve: () => void;
}

const COL = 56; // px per step
const LANE = 40; // px per chain lane
const LABEL = 150; // lane label column

const laneOf = (s: StepView) => (s.kind === "check" ? "checks" : s.chain);

function nodeTone(s: StepView, active: boolean): string {
  if (s.status === "failed") return "bg-bad border-bad text-bg";
  if (s.status === "confirmed") return "bg-accent border-accent text-accent-ink node-done";
  if (s.status === "signed" || s.status === "broadcast" || active) return "bg-warn/20 border-warn text-warn animate-pulse";
  if (s.kind === "check") return "bg-bg border-line-2 text-dim";
  return "bg-panel-2 border-dim text-text";
}

/** The plan as a flow across chains: one lane per chain, one column per step, a line in run order. */
function Lanes({ steps, selected, onSelect, active, running, planKey }: {
  steps: StepView[];
  selected: string | null;
  onSelect: (id: string) => void;
  active?: string;
  running?: boolean;
  /** Changes on every new simulation, so the entrance animation replays. */
  planKey: string;
}) {
  const lanes = useMemo(() => {
    const out: string[] = [];
    for (const s of steps) if (!out.includes(laneOf(s))) out.push(laneOf(s));
    // checks on top, then chains in order of first appearance
    return out.sort((a, b) => (a === "checks" ? -1 : b === "checks" ? 1 : 0));
  }, [steps]);
  const x = (i: number) => LABEL + COL / 2 + i * COL;
  const y = (s: StepView) => LANE / 2 + lanes.indexOf(laneOf(s)) * LANE;
  const width = LABEL + steps.length * COL + 24;
  const height = lanes.length * LANE;
  const path = steps.map((s, i) => `${i ? "L" : "M"}${x(i)},${y(s)}`).join(" ");
  const len = steps.reduce((acc, s, i) => (i ? acc + Math.hypot(COL, y(s) - y(steps[i - 1])) : 0), 0) + 1;

  return (
    <div className="overflow-x-auto">
      <div className="relative" style={{ width, height }}>
        {lanes.map((l, i) => (
          <div key={l} className="absolute left-0 right-0 flex items-center" style={{ top: i * LANE, height: LANE }}>
            <div className="text-[11px] text-dim truncate pr-3 font-mono" style={{ width: LABEL }} title={l}>{l}</div>
            <div className="flex-1 border-t border-dashed border-line" />
          </div>
        ))}
        <svg key={planKey} className="absolute inset-0 pointer-events-none" width={width} height={height}>
          <path
            d={path}
            fill="none"
            stroke="var(--color-line-2)"
            strokeWidth="1.5"
            strokeLinejoin="round"
            className={running ? "route-run" : "route-draw"}
            style={{ ["--len" as string]: len }}
          />
        </svg>
        {steps.map((s, i) => {
          const danger = s.risk?.includes("irreversible") || s.risk?.includes("high-value");
          return (
            <button
              key={`${planKey}:${s.id}`}
              onClick={() => onSelect(s.id)}
              title={`${s.n}. ${s.title}`}
              className={`node-pop absolute -translate-x-1/2 -translate-y-1/2 w-7 h-7 rounded-full border text-[11px] font-mono font-bold flex items-center justify-center cursor-pointer
                ${nodeTone(s, s.id === active)} ${selected === s.id ? "ring-2 ring-accent ring-offset-2 ring-offset-bg" : ""}`}
              style={{ left: x(i), top: y(s), animationDelay: `${i * 70}ms` }}
            >
              {s.kind === "check" ? (s.status === "failed" ? "×" : "?") : s.kind === "wait" ? "…" : s.n}
              {danger && <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-bad border border-bg" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function FlowPanel({ snap, busy, walletReady, walletWarning, act }: {
  snap: Snapshot | null;
  busy: boolean;
  walletReady: boolean;
  walletWarning?: string;
  act: FlowActions;
}) {
  const v = snap?.view;
  const current = snap?.running ? v?.steps.find((s) => s.status !== "confirmed")?.id : undefined;
  const [selected, setSelected] = useState<string | null>(null);

  // Follow the run; otherwise land on what needs attention.
  const focus = v?.steps.find((s) => s.status === "failed")?.id ?? current ?? v?.steps.find((s) => s.kind !== "check")?.id ?? null;
  useEffect(() => {
    if (!v || !selected || !v.steps.some((s) => s.id === selected)) setSelected(focus);
  }, [v?.hash]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (current) setSelected(current);
  }, [current]);

  if (!snap || !v) {
    return (
      <div className="h-full flex items-center justify-center text-faint text-[12px]">
        Simulate to see the flow · nothing is signed
      </div>
    );
  }
  const step = v.steps.find((s) => s.id === selected) ?? null;
  const planKey = `${v.hash}:${snap.run}`;
  const started = snap.run !== "none";
  const failedNear = v.steps.some((s) => s.status === "failed" && s.kind === "near");
  const done = v.steps.filter((s) => s.status === "confirmed").length;
  const fails = v.checks.filter((c) => c.level === "fail").length + v.problems.filter((p) => !v.checks.some((c) => c.description === p)).length;
  const warns = v.checks.filter((c) => c.level === "warn").length;

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="h-10 shrink-0 flex items-center gap-3 px-4 border-b border-line">
        <ModeLine snap={snap} />
        <div className="flex-1" />
        {snap.run === "none" && fails > 0 && <span className="text-bad text-[12px]">blocked · {fails}</span>}
        {snap.run === "none" && (
          <Button variant="primary" disabled={busy || v.problems.length > 0 || v.txCount === 0} onClick={act.review}>
            Review & execute →
          </Button>
        )}
        {snap.running && (
          <>
            <span className="text-accent text-[12px]">running {done}/{v.steps.length}</span>
            <Button variant="danger" onClick={act.kill} title="Simulate a crash at the next checkpoint write">Kill</Button>
          </>
        )}
        {!snap.running && snap.run === "unfinished" && (
          <>
            <span className="text-dim text-[12px]">{done}/{v.steps.length}</span>
            {failedNear && <Button disabled={busy} onClick={() => act.resume(true)}>Retry failed</Button>}
            <Button variant="primary" disabled={busy || !!snap.handoff} onClick={() => act.resume(false)}>Resume</Button>
          </>
        )}
        {!snap.running && snap.run === "complete" && (
          <>
            <span className="text-accent text-[12px] glow-text">✓ all confirmed</span>
            <Button disabled={busy} onClick={act.fresh}>Run again</Button>
          </>
        )}
      </div>

      {snap.walletRequest && (
        <div className="shrink-0 flex items-center gap-3 px-4 py-2 border-b border-warn/40 bg-warn/5">
          <span className="text-warn">●</span>
          <div className="flex-1 min-w-0 truncate">
            Step {snap.walletRequest.step} needs your wallet · <span className="text-dim">{snap.walletRequest.signerId} → {snap.walletRequest.receiverId}</span>
          </div>
          <Button variant="primary" disabled={!walletReady} onClick={act.approve}>Approve in wallet</Button>
        </div>
      )}
      {walletWarning && <div className="shrink-0 px-4 py-1.5 text-warn text-[12px] border-b border-line">{walletWarning}</div>}

      <div className="flex-1 min-h-0 grid grid-cols-[minmax(0,1fr)_minmax(340px,440px)]">
        <div className="min-h-0 overflow-y-auto px-4 py-4 flex flex-col gap-4">
          <Lanes steps={v.steps} selected={selected} onSelect={setSelected} active={current} running={snap.running} planKey={planKey} />
          <div className="flex items-center gap-4 text-[12px] text-dim">
            <button className="hover:text-text cursor-pointer" onClick={() => setSelected(null)}>
              checks <span className="text-accent">✓{v.checks.filter((c) => c.level === "ok").length}</span>
              {warns > 0 && <span className="text-warn ml-1">!{warns}</span>}
              {fails > 0 && <span className="text-bad ml-1">×{fails}</span>}
            </button>
            {v.txCount > 0 && <span className="truncate">{v.cost}</span>}
          </div>
          {v.prints.length > 0 && (
            <div className="text-[12px] font-mono flex flex-col gap-1">
              {v.prints.map((p, i) => <div key={i} className="break-all"><span className="text-faint">› </span>{p}</div>)}
            </div>
          )}
          {snap.outcome && !snap.running && <div className={`text-[12px] ${/confirmed\.?$/.test(snap.outcome) ? "text-accent" : "text-dim"}`}>{snap.outcome}</div>}
          {snap.log && snap.log.length > 0 && (
            <details className="text-[12px]" open={snap.running}>
              <summary className="text-dim cursor-pointer select-none">log · {snap.log.length}</summary>
              <pre className="mt-2 p-3 bg-bg border border-line rounded whitespace-pre-wrap break-all max-h-56 overflow-y-auto font-mono">{snap.log.join("\n")}</pre>
            </details>
          )}
        </div>
        <aside className="min-h-0 overflow-y-auto border-l border-line p-4 bg-panel/40">
          {step ? (
            <StepCard s={step} showStatus={started} active={step.id === current} />
          ) : (
            <div className="flex flex-col gap-3">
              <div className="text-[11px] uppercase tracking-wider text-faint">Checks</div>
              <Checks v={v} />
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
