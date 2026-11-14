import { useEffect, useMemo, useState } from "react";
import type { Risk, Snapshot, StepView } from "@api";
import { modeOf } from "./Risk.tsx";
import { Checks } from "./Summary.tsx";
import { Button, Copy } from "./ui.tsx";

export interface FlowActions {
  review: () => void;
  resume: (retryFailed: boolean) => void;
  kill: () => void;
  fresh: () => void;
  approve: () => void;
}

const COL = 64; // px per step
const LANE = 44; // px per chain lane
const LABEL = 132; // lane label column
const NODE = 22;

const laneOf = (s: StepView) => (s.kind === "check" ? "Checks" : s.kind === "wait" ? "NEAR Intents" : s.chain);

/** Status as VS Code's Testing view shows it: one codicon per state. */
function statusIcon(s: StepView, active: boolean): { icon: string; cls: string; spin?: boolean } {
  if (s.status === "failed") return { icon: "codicon-error", cls: "text-bad" };
  if (s.status === "confirmed") return { icon: "codicon-pass-filled", cls: "text-accent" };
  if (s.status === "signed" || s.status === "broadcast" || active) return { icon: "codicon-loading", cls: "text-accent", spin: true };
  return { icon: "codicon-circle-large-outline", cls: "text-faint" };
}

/** The plan as a flow across chains: one lane per chain, one column per step, joined in run order. */
function Lanes({ steps, selected, onSelect, active }: {
  steps: StepView[];
  selected: string | null;
  onSelect: (id: string) => void;
  active?: string;
}) {
  const lanes = useMemo(() => {
    const out: string[] = [];
    for (const s of steps) if (!out.includes(laneOf(s))) out.push(laneOf(s));
    return out.sort((a, b) => (a === "Checks" ? -1 : b === "Checks" ? 1 : 0));
  }, [steps]);
  const x = (i: number) => LABEL + COL / 2 + i * COL;
  const y = (s: StepView) => LANE / 2 + lanes.indexOf(laneOf(s)) * LANE;
  const width = LABEL + steps.length * COL + 16;
  const height = lanes.length * LANE;

  return (
    <div className="overflow-x-auto">
      <div className="relative" style={{ width, height }}>
        {lanes.map((l, i) => (
          <div key={l} className={`absolute left-0 right-0 flex items-center ${i % 2 ? "bg-white/[0.015]" : ""}`} style={{ top: i * LANE, height: LANE }}>
            <div className="pl-3 text-[11px] text-dim truncate" style={{ width: LABEL }} title={l}>{l}</div>
          </div>
        ))}
        <svg className="absolute inset-0 pointer-events-none" width={width} height={height}>
          {steps.slice(1).map((s, i) => {
            const prev = steps[i];
            const done = prev.status === "confirmed" && s.status !== "planned";
            return (
              <line
                key={s.id}
                x1={x(i)} y1={y(prev)} x2={x(i + 1)} y2={y(s)}
                stroke={done ? "var(--color-accent)" : "#3c3c3c"}
                strokeWidth="1.5"
              />
            );
          })}
        </svg>
        {steps.map((s, i) => {
          const st = statusIcon(s, s.id === active);
          const sel = selected === s.id;
          return (
            <button
              key={s.id}
              onClick={() => onSelect(s.id)}
              title={`${s.n}. ${s.title}`}
              className="absolute -translate-x-1/2 flex flex-col items-center cursor-pointer group"
              style={{ left: x(i), top: y(s) - NODE / 2 }}
            >
              <span
                className={`flex items-center justify-center rounded-full bg-panel ${sel ? "outline outline-1 outline-accent outline-offset-2" : "group-hover:outline group-hover:outline-1 group-hover:outline-[#5a5a5a] group-hover:outline-offset-2"}`}
                style={{ width: NODE, height: NODE }}
              >
                <i className={`codicon ${st.icon} ${st.cls} ${st.spin ? "codicon-modifier-spin" : ""}`} style={{ fontSize: 18 }} />
              </span>
              <span className={`mt-1 text-[10px] leading-none font-mono ${sel ? "text-text" : "text-faint"}`}>{s.n}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const RISK_CLS: Record<Risk, string> = {
  "read-only": "text-dim border-line-2",
  "state-changing": "text-warn border-warn/40",
  irreversible: "text-bad border-bad/40",
  "high-value": "text-bad border-bad/60 font-semibold",
};

export function RiskChip({ r }: { r: Risk }) {
  return <span className={`h-[18px] px-1.5 inline-flex items-center rounded-sm border text-[10px] uppercase tracking-wide whitespace-nowrap ${RISK_CLS[r]}`}>{r}</span>;
}

const STATUS_LABEL: Record<StepView["status"], string> = {
  planned: "Not started",
  signed: "Signed",
  broadcast: "Sent, waiting for confirmation",
  confirmed: "Confirmed",
  failed: "Failed",
};

/** One step's details, laid out like a VS Code property view. */
export function StepDetails({ s, started, active }: { s: StepView; started: boolean; active: boolean }) {
  const st = statusIcon(s, active);
  const row = (k: string, v: React.ReactNode, copy?: string) => (
    <div key={k} className="group grid grid-cols-[88px_minmax(0,1fr)_auto] items-center gap-2 h-[22px]">
      <span className="text-dim truncate">{k}</span>
      <span className="font-mono text-[12px] truncate" title={typeof v === "string" ? v : undefined}>{v}</span>
      <span className="opacity-0 group-hover:opacity-100">{copy && <Copy text={copy} />}</span>
    </div>
  );
  const firstId = (v: string) => /(0x[0-9a-fA-F]{8,}|[0-9a-f]{64}|[1-9A-HJ-NP-Za-km-z]{32,}|[\w.-]+\.(?:testnet|near))/.exec(v)?.[1];
  return (
    <div className="flex flex-col gap-3 text-[12px]">
      <div className="flex items-start gap-2">
        <i className={`codicon ${st.icon} ${st.cls} ${st.spin ? "codicon-modifier-spin" : ""} mt-0.5`} style={{ fontSize: 16 }} />
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold leading-snug">
            <span className="text-faint font-mono font-normal mr-1.5">{s.n}</span>{s.title}
          </div>
          <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
            <span className="h-[18px] px-1.5 inline-flex items-center rounded-sm bg-white/[0.06] text-[10px] text-dim">{s.chain}</span>
            {s.risk?.map((r) => <RiskChip key={r} r={r} />)}
            {s.signedWith === "wallet" && <span className="h-[18px] px-1.5 inline-flex items-center rounded-sm bg-white/[0.06] text-[10px] text-dim">wallet signs</span>}
          </div>
        </div>
      </div>

      {s.danger && (
        <div className="flex gap-2 px-2 py-1.5 rounded-sm bg-bad/10 border border-bad/30 text-bad">
          <i className="codicon codicon-warning" style={{ fontSize: 14 }} />
          <span>{s.danger}</span>
        </div>
      )}

      {s.rows.length > 0 && <div className="flex flex-col">{s.rows.map(([k, v]) => row(k, v, firstId(v)))}</div>}

      {s.actions.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-[11px] uppercase tracking-wide text-faint">
            {s.atomic ? `${s.actions.length} actions · atomic` : "Action"}
          </div>
          <pre className="m-0 px-2.5 py-2 rounded-sm bg-bg border border-line font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-all">
            {s.actions.join("\n")}
          </pre>
        </div>
      )}

      {(started || s.error || s.result) && (
        <div className="flex flex-col pt-2 border-t border-line">
          {started && row("status", <span className={st.cls}>{STATUS_LABEL[s.status]}</span>)}
          {s.txHash && row("tx", s.url ? <a className="text-text underline decoration-faint underline-offset-2 hover:text-accent" href={s.url} target="_blank" rel="noreferrer">{s.txHash}</a> : s.txHash, s.txHash)}
          {s.fee && row("fee paid", s.fee)}
          {s.result && row("result", s.result, s.result)}
          {s.error && <div className="mt-1 text-bad break-words">{s.error}</div>}
          {s.hint && (
            <div className="mt-1 flex gap-1.5 text-text">
              <i className="codicon codicon-lightbulb text-warn" style={{ fontSize: 14 }} />
              <span>{s.hint}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function FlowView({ snap }: { snap: Snapshot | null }) {
  const v = snap?.view;
  const current = snap?.running ? v?.steps.find((s) => s.status !== "confirmed")?.id : undefined;
  const [selected, setSelected] = useState<string | null>(null);
  const focus = v?.steps.find((s) => s.status === "failed")?.id ?? current ?? v?.steps.find((s) => s.kind !== "check")?.id ?? null;
  useEffect(() => {
    if (!v || !selected || !v.steps.some((s) => s.id === selected)) setSelected(focus);
  }, [v?.hash]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (current) setSelected(current);
  }, [current]);
  if (!snap || !v) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-1 text-dim">
        <i className="codicon codicon-type-hierarchy-sub" style={{ fontSize: 28, opacity: 0.4 }} />
        <span>Simulate (⌘↵) to see the flow across chains.</span>
        <span className="text-faint text-[12px]">Simulating reads the chains and signs nothing.</span>
      </div>
    );
  }
  const step = v.steps.find((s) => s.id === selected) ?? null;
  const ok = !!snap.outcome && /confirmed\.?$/.test(snap.outcome);
  return (
    <div className="h-full min-h-0 grid grid-cols-[minmax(0,1fr)_minmax(320px,400px)]">
      <div className="min-h-0 overflow-auto py-3 flex flex-col gap-3">
        <Lanes steps={v.steps} selected={selected} onSelect={setSelected} active={current} />
        <div className="px-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-dim">
          <span><span className="text-faint">steps</span> {v.steps.length}</span>
          <span><span className="text-faint">transactions</span> {v.txCount}</span>
          <span><span className="text-faint">chains</span> {v.chainCount}</span>
          {v.txCount > 0 && <span className="truncate"><span className="text-faint">max cost</span> {v.cost}</span>}
        </div>
        {snap.outcome && !snap.running && (
          <div className={`px-3 text-[12px] flex items-center gap-1.5 ${ok ? "text-accent" : "text-dim"}`}>
            <i className={`codicon ${ok ? "codicon-pass-filled" : "codicon-info"}`} style={{ fontSize: 14 }} />
            {snap.outcome}
          </div>
        )}
      </div>
      <aside className="min-h-0 overflow-y-auto border-l border-line px-4 py-3">
        {step ? <StepDetails s={step} started={snap.run !== "none"} active={step.id === current} /> : <Checks v={v} />}
      </aside>
    </div>
  );
}

function ToolbarButton({ icon, title, onClick, disabled, cls = "" }: { icon: string; title: string; onClick: () => void; disabled?: boolean; cls?: string }) {
  return (
    <button
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={`w-[26px] h-[22px] flex items-center justify-center rounded hover:bg-[#5a5d5e50] cursor-pointer disabled:opacity-40 disabled:cursor-default ${cls}`}
    >
      <i className={`codicon ${icon}`} style={{ fontSize: 16 }} />
    </button>
  );
}

const MODE_TEXT = { "SIMULATE-ONLY": "Simulated", EXECUTING: "Executing", DONE: "Done", STOPPED: "Stopped" } as const;

/** Run controls for the panel's title area, like VS Code's debug toolbar. */
export function PanelActions({ snap, busy, act }: { snap: Snapshot | null; busy: boolean; act: FlowActions }) {
  const v = snap?.view;
  if (!snap || !v) return null;
  const mode = modeOf(snap);
  const failedNear = v.steps.some((s) => s.status === "failed" && s.kind === "near");
  const done = v.steps.filter((s) => s.status === "confirmed").length;
  return (
    <div className="flex items-center gap-2 pr-2 h-full text-[12px]">
      <span className="text-dim">{MODE_TEXT[mode]}</span>
      <span className="text-faint">·</span>
      <span className={v.network === "mainnet" ? "text-bad font-semibold" : "text-dim"}>{v.network}</span>
      <RiskChip r={v.risk} />
      {snap.run !== "none" && <span className="text-dim tabular-nums">{done}/{v.steps.length}</span>}
      <span className="w-px h-4 bg-line-2 mx-1" />
      {snap.run === "none" && (
        <Button variant="primary" disabled={busy || v.problems.length > 0 || v.txCount === 0} onClick={act.review}>Review & Execute</Button>
      )}
      {snap.running && <ToolbarButton icon="codicon-debug-stop" title="Kill (simulates a crash at the next checkpoint write)" onClick={act.kill} cls="text-bad" />}
      {!snap.running && snap.run === "unfinished" && (
        <>
          <ToolbarButton icon="codicon-debug-continue" title="Resume from the checkpoint" onClick={() => act.resume(false)} disabled={busy || !!snap.handoff} cls="text-accent" />
          {failedNear && <ToolbarButton icon="codicon-debug-restart" title="Resume and retry the failed step" onClick={() => act.resume(true)} disabled={busy} />}
        </>
      )}
      {!snap.running && snap.run === "complete" && <ToolbarButton icon="codicon-debug-rerun" title="Run again" onClick={act.fresh} disabled={busy} />}
    </div>
  );
}

/** The wallet prompt strip shown above the panel when a step waits for a wallet. */
export function WalletStrip({ snap, walletReady, walletWarning, onApprove }: { snap: Snapshot | null; walletReady: boolean; walletWarning?: string; onApprove: () => void }) {
  const r = snap?.walletRequest;
  if (!r && !walletWarning) return null;
  return (
    <div className="shrink-0 h-8 flex items-center gap-2 px-3 border-b border-line bg-[#cca70014] text-[12px]">
      <i className="codicon codicon-key text-warn" style={{ fontSize: 14 }} />
      <div className="flex-1 min-w-0 truncate">
        {r ? (r.kind === "evm"
          ? <>Step {r.step} · send from MetaMask on {r.evm?.chainName} <span className="text-dim font-mono">{r.signerId.slice(0, 10)}… → {r.receiverId.slice(0, 10)}…</span></>
          : <>Step {r.step} · approve in your NEAR wallet <span className="text-dim">{r.signerId} → {r.receiverId}</span></>) : null}
        {walletWarning && <span className="text-warn ml-2">{walletWarning}</span>}
      </div>
      {r && <Button variant="primary" disabled={!walletReady} onClick={onApprove}>{r.kind === "evm" ? "Send with MetaMask" : "Approve in Wallet"}</Button>}
    </div>
  );
}
