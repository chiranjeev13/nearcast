import type { InfoResponse, Network, SignerMode, Snapshot } from "@api";
import { modeOf } from "./Risk.tsx";
import { short } from "./ui.tsx";

/** IDE-style status bar: network, signer, account on the left; run state on the right. */
export function StatusBar(p: {
  info: InfoResponse | null;
  network: Network;
  setNetwork: (n: Network) => void;
  signer: SignerMode;
  setSigner: (s: SignerMode) => void;
  keyAccount: string;
  setKeyAccount: (a: string) => void;
  walletAccount: string | null;
  walletLoading: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  snap: Snapshot | null;
  message: { text: string; bad: boolean } | null;
}) {
  const keys = p.info?.keyAccounts[p.network] ?? [];
  const networks = p.info?.networks ?? ["testnet", "mainnet"];
  const mainnet = p.network === "mainnet";
  const cell = "h-full px-3 flex items-center gap-1.5 hover:bg-white/5 cursor-pointer whitespace-nowrap";
  const v = p.snap?.view;
  return (
    <footer className={`h-7 shrink-0 flex items-stretch text-[11.5px] border-t ${mainnet ? "border-bad/60 bg-bad/10" : "border-line bg-panel"}`}>
      <button
        className={`${cell} font-medium ${mainnet ? "text-bad" : "text-accent"}`}
        title="Switch network"
        onClick={() => p.setNetwork(networks[(networks.indexOf(p.network) + 1) % networks.length] as Network)}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${mainnet ? "bg-bad" : "bg-accent"}`} />
        NEAR {p.network}
      </button>
      <button
        className={`${cell} text-dim`}
        title={keys.length ? "Switch signer: local key or browser wallet" : `No local key for ${p.network}: wallet only`}
        onClick={() => keys.length && p.setSigner(p.signer === "key" ? "wallet" : "key")}
      >
        signer <span className="text-text">{p.signer}</span>
      </button>
      {p.signer === "key" ? (
        keys.length > 1 ? (
          <select value={p.keyAccount} onChange={(e) => p.setKeyAccount(e.target.value)} className={`${cell} bg-transparent text-text outline-none font-mono`}>
            {keys.map((k) => <option key={k} value={k}>{short(k, 10)}</option>)}
          </select>
        ) : (
          <span className={`${cell} cursor-default font-mono text-text`} title={p.keyAccount}>{p.keyAccount ? short(p.keyAccount, 8) : "no key"}</span>
        )
      ) : p.walletAccount ? (
        <button className={`${cell} font-mono text-text`} onClick={p.onDisconnect} title={`${p.walletAccount} · click to disconnect`}>
          <span className="w-1.5 h-1.5 rounded-full bg-accent" />{short(p.walletAccount, 8)}
        </button>
      ) : (
        <button className={`${cell} text-accent`} onClick={p.onConnect} disabled={p.walletLoading}>
          {p.walletLoading ? "loading wallets…" : "connect wallet"}
        </button>
      )}
      <div className={`flex-1 min-w-0 px-3 flex items-center truncate ${p.message?.bad ? "text-bad" : "text-dim"}`}>{p.message?.text}</div>
      {v && p.snap && (
        <div className="px-3 flex items-center gap-3 text-dim whitespace-nowrap">
          <span>{v.steps.length} steps · {v.txCount} tx · {v.chainCount} chain{v.chainCount === 1 ? "" : "s"}</span>
          <span className="text-text">{modeOf(p.snap)}</span>
        </div>
      )}
    </footer>
  );
}
