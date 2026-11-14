import type { Network, SignerMode, Snapshot } from "@api";
import { modeOf } from "./Risk.tsx";
import { short } from "./ui.tsx";

/** VS Code's status bar: remote-style network item, account, problems; cursor and language on the right. */
export function StatusBar(p: {
  network: Network;
  onNetwork: () => void;
  signer: SignerMode;
  account: string;
  evmAccount: string | null;
  onAccount: () => void;
  errors: number;
  warnings: number;
  onProblems: () => void;
  cursor: { line: number; col: number };
  snap: Snapshot | null;
  message: { text: string; bad: boolean } | null;
}) {
  const mainnet = p.network === "mainnet";
  const item = "h-full px-2 flex items-center gap-1 hover:bg-white/10 cursor-pointer whitespace-nowrap";
  return (
    <footer className="h-[22px] shrink-0 flex items-stretch text-[12px] bg-panel border-t border-line text-text">
      <button
        onClick={p.onNetwork}
        title="Switch NEAR network"
        className={`h-full px-2.5 flex items-center gap-1 font-medium cursor-pointer ${mainnet ? "bg-bad text-white" : "bg-accent text-accent-ink"}`}
      >
        <i className="codicon codicon-remote" style={{ fontSize: 14 }} />
        NEAR {p.network}
      </button>
      <button className={item} onClick={p.onAccount} title="Signer and accounts (Run and Simulate view)">
        <i className={`codicon ${p.signer === "key" ? "codicon-key" : "codicon-account"}`} style={{ fontSize: 14 }} />
        {p.account ? short(p.account, 8) : "no account"}
      </button>
      {p.evmAccount && (
        <span className={item} title={`EVM wallet ${p.evmAccount}`}>
          <i className="codicon codicon-plug" style={{ fontSize: 14 }} />
          {short(p.evmAccount, 6)}
        </span>
      )}
      <button className={item} onClick={p.onProblems} title="Problems">
        <i className="codicon codicon-error" style={{ fontSize: 14 }} /> {p.errors}
        <i className="codicon codicon-warning ml-1" style={{ fontSize: 14 }} /> {p.warnings}
      </button>
      <div className={`flex-1 min-w-0 px-2 flex items-center truncate ${p.message?.bad ? "text-bad" : "text-dim"}`}>{p.message?.text}</div>
      {p.snap?.running && (
        <span className={item}>
          <i className="codicon codicon-loading codicon-modifier-spin" style={{ fontSize: 14 }} /> running
        </span>
      )}
      <span className={item}>Ln {p.cursor.line}, Col {p.cursor.col}</span>
      <span className={item}>Spaces: 2</span>
      <span className={item}>Cast</span>
      {p.snap?.view && <span className={item}>{modeOf(p.snap)}</span>}
      <span className={item} title="Notifications"><i className="codicon codicon-bell" style={{ fontSize: 14 }} /></span>
    </footer>
  );
}
