import { useState } from "react";
import type { PlanView, SignerMode } from "@api";
import { RiskTag } from "./Risk.tsx";
import { StepCard } from "./StepCard.tsx";
import { Checks, Summary } from "./Summary.tsx";
import { Modal, ModalHead } from "./ui.tsx";

export function ReviewModal({ v, signer, warning, busy, onConfirm, onClose, onReplan }: {
  v: PlanView;
  signer: SignerMode;
  warning?: string;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
  onReplan: () => void;
}) {
  const [typed, setTyped] = useState("");
  const mainnet = v.network === "mainnet";
  const n = v.txCount;
  const label = signer === "wallet"
    ? `Confirm ${v.walletTxCount || n} in wallet`
    : `Sign and send ${n} transaction${n === 1 ? "" : "s"}`;
  const blocked = v.problems.length > 0 || (mainnet && typed.trim().toLowerCase() !== "mainnet");
  const danger = v.steps.filter((s) => s.danger).length;

  return (
    <Modal wide onClose={onClose}>
      <ModalHead
        title="Review transactions"
        sub={signer === "wallet" ? "Simulated first. Your wallet signs each NEAR step." : "Simulated first. The local key signs."}
        onClose={onClose}
      />
      <div className="px-6 py-5 flex flex-col gap-4 max-h-[62vh] overflow-y-auto">
        <div className="flex items-center justify-between gap-3">
          <div className="text-[12px] min-w-0">
            <span className="text-faint">Mode: </span><span className="text-warn">EXECUTE</span>
            <span className="text-faint"> | Network: </span><span className={mainnet ? "text-bad font-bold" : ""}>{v.network}</span>
            <span className="text-faint"> | Risk: </span><RiskTag r={v.risk} />
          </div>
          <button className="h-8 px-3 border border-line-2 rounded-[3px] hover:border-dim cursor-pointer disabled:opacity-40 shrink-0" disabled={busy} onClick={onReplan}>Simulate again</button>
        </div>
        <div className={v.problems.length ? "text-bad" : "text-accent"}>
          {v.problems.length ? `Blocked: ${v.problems.length} problem${v.problems.length === 1 ? "" : "s"}.` : "Simulation passed. Nothing signed yet."}
        </div>
        <Summary v={v} />
        {v.simulated?.length > 0 && (
          <div className="text-[12px] flex flex-col gap-1">
            <div className="text-dim">Simulated</div>
            {v.simulated.map((x, i) => <div key={i}><span className="text-accent">✓ </span>{x}</div>)}
          </div>
        )}
        <Checks v={v} />
        {danger > 0 && <div className="text-bad text-[12px]">! {danger} step{danger === 1 ? "" : "s"} need{danger === 1 ? "s" : ""} extra care</div>}
        {warning && <div className="text-warn text-[12px]">{warning}</div>}
        <div className="flex flex-col gap-3">
          {v.steps.map((s) => <StepCard key={s.id} s={s} showStatus={false} />)}
        </div>
        <div className="text-faint text-[11px]">{v.cost}. Steps are not atomic with each other.</div>
      </div>
      <div className="px-6 py-5 border-t border-line flex flex-col gap-3">
        {mainnet && (
          <label className="flex items-center gap-3 text-[12px]">
            <span className="text-warn">Type mainnet to enable</span>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="flex-1 h-8 px-2 bg-bg border border-line-2 rounded-[3px] outline-none focus:border-warn"
              autoFocus
            />
          </label>
        )}
        <button
          disabled={blocked || busy}
          onClick={onConfirm}
          className="h-14 w-full bg-accent text-accent-ink text-[18px] font-bold rounded-[3px] shadow-[0_4px_0_#5d8f3c] active:translate-y-[2px] active:shadow-[0_2px_0_#5d8f3c] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
        >
          {busy ? "…" : label}
        </button>
      </div>
    </Modal>
  );
}
