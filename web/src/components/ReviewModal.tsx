import { useState } from "react";
import type { PlanView, SignerMode } from "@api";
import { RiskChip, StepDetails } from "./FlowPanel.tsx";
import { Checks } from "./Summary.tsx";
import { Button, Modal, short } from "./ui.tsx";

/** Final confirmation before anything is signed, as a VS Code dialog. */
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
  const label = signer === "wallet" ? `Confirm ${v.walletTxCount || n} in Wallet` : `Sign and Send ${n} Transaction${n === 1 ? "" : "s"}`;
  const blocked = v.problems.length > 0 || (mainnet && typed.trim().toLowerCase() !== "mainnet");
  const danger = v.steps.filter((s) => s.danger).length;
  const cells: [string, string, string?][] = [
    ["Network", `NEAR ${v.network}`, mainnet ? "text-bad" : undefined],
    ["From", short(v.account, 10)],
    ["Transactions", `${n} on ${v.chainCount} chain${v.chainCount === 1 ? "" : "s"}`],
  ];

  return (
    <Modal wide onClose={onClose}>
      <div className="flex items-center gap-2 h-[35px] px-4 border-b border-line">
        <i className="codicon codicon-rocket text-accent" />
        <span className="font-semibold">Review & Execute</span>
        <span className="text-dim text-[12px]">· simulated, nothing signed yet</span>
        <div className="flex-1" />
        <RiskChip r={v.risk} />
        <button onClick={onClose} className="w-[22px] h-[22px] flex items-center justify-center rounded hover:bg-white/10 cursor-pointer" aria-label="Close">
          <i className="codicon codicon-close" />
        </button>
      </div>

      <div className="px-4 py-3 flex flex-col gap-3 max-h-[64vh] overflow-y-auto text-[12px]">
        <div className="grid grid-cols-3 border border-line rounded-sm divide-x divide-line">
          {cells.map(([k, val, cls]) => (
            <div key={k} className="px-3 py-2 min-w-0">
              <div className="text-faint text-[11px]">{k}</div>
              <div className={`mt-0.5 font-mono truncate ${cls ?? ""}`} title={k === "From" ? v.account : undefined}>{val}</div>
            </div>
          ))}
        </div>

        {v.simulated?.length > 0 && (
          <div className="flex flex-col gap-1">
            {v.simulated.map((x, i) => (
              <div key={i} className="flex items-center gap-1.5 text-dim">
                <i className="codicon codicon-pass-filled text-accent" style={{ fontSize: 14 }} />{x}
              </div>
            ))}
          </div>
        )}
        <Checks v={v} />
        {danger > 0 && (
          <div className="flex items-center gap-1.5 text-bad">
            <i className="codicon codicon-warning" style={{ fontSize: 14 }} />
            {danger} step{danger === 1 ? "" : "s"} need{danger === 1 ? "s" : ""} extra care
          </div>
        )}
        {warning && <div className="text-warn">{warning}</div>}

        <div className="flex flex-col">
          {v.steps.map((s) => (
            <div key={s.id} className="py-3 border-t border-line first:border-t-0">
              <StepDetails s={s} started={false} active={false} />
            </div>
          ))}
        </div>
        <div className="text-faint text-[11px]">Max cost: {v.cost}. Steps are not atomic with each other.</div>
      </div>

      <div className="px-4 py-3 border-t border-line flex items-center gap-2">
        {mainnet ? (
          <label className="flex items-center gap-2 text-[12px] flex-1">
            <span className="text-bad">Type mainnet to confirm</span>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="w-32 h-[26px] px-2 bg-[#313131] border border-[#3c3c3c] rounded-[2px] outline-none focus:border-bad"
              autoFocus
            />
          </label>
        ) : (
          <div className="flex-1" />
        )}
        <Button disabled={busy} onClick={onReplan}>Simulate Again</Button>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={blocked || busy} onClick={onConfirm}>{busy ? "Working…" : label}</Button>
      </div>
    </Modal>
  );
}
