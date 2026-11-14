import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Ctx, EntryDoc, InfoResponse, Network, SignerMode, Snapshot } from "@api";
import { ActivityBar, type View } from "./components/ActivityBar.tsx";
import { Editor, type EditorApi, type Marker } from "./components/Editor.tsx";
import { HandoffDialog } from "./components/HandoffDialog.tsx";
import { Confetti } from "./components/Confetti.tsx";
import { Landing } from "./components/Landing.tsx";
import { WalletStrip } from "./components/FlowPanel.tsx";
import { Panel, problemsOf, type PanelTab } from "./components/Panel.tsx";
import { Sash } from "./components/Sash.tsx";
import { SideBar } from "./components/SideBar.tsx";
import { ReviewModal } from "./components/ReviewModal.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { api, ApiError } from "./lib/api.ts";
import { snippetFor } from "./lib/completions.ts";
import { useDocuments } from "./lib/documents.ts";
import { session, store } from "./lib/storage.ts";
import { connectEvm, currentEvm, hasEvmWallet, sendEvm, watchEvm } from "./lib/evmWallet.ts";
import { connect, disconnect, getWallet, sendWithWallet, splitsBatches, watchAccount, type WalletAccount, type WalletHandle } from "./lib/wallet.ts";

interface Pending {
  id: string;
  hash: string;
  ctx: Ctx;
}

export function App() {
  const [info, setInfo] = useState<InfoResponse | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [network, setNetwork] = useState<Network>(() => store.get("network", "testnet"));
  const [signer, setSigner] = useState<SignerMode>(() => store.get("signer", "key"));
  const [keyAccount, setKeyAccount] = useState<string>(() => store.get("keyAccount", ""));
  const [creating, setCreating] = useState(false);
  // "/" is the landing page; "#editor" is the workbench. Back/forward move between them.
  const [page, setPage] = useState<"home" | "editor">(() => (location.hash === "#editor" ? "editor" : "home"));
  useEffect(() => {
    const on = () => setPage(location.hash === "#editor" ? "editor" : "home");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const [view, setView] = useState<View>(() => store.get("view", "explorer"));
  const [sideOpen, setSideOpen] = useState<boolean>(() => store.get("sideOpen", true));
  const [panelTab, setPanelTab] = useState<PanelTab>("flow");
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [sideW, setSideW] = useState<number>(() => store.get("sideW", 300));
  const [panelH, setPanelH] = useState<number>(() => store.get("panelH", 300));
  useEffect(() => store.set("sideW", sideW), [sideW]);
  useEffect(() => store.set("panelH", panelH), [panelH]);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [planErr, setPlanErr] = useState<{ msg: string; line: number | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [wallet, setWallet] = useState<WalletHandle | null>(null);
  const [walletAcct, setWalletAcct] = useState<WalletAccount | null>(null);
  // The browser's EVM wallet (MetaMask), for steps that spend from the user's own EVM address.
  const [evmAcct, setEvmAcct] = useState<string | null>(null);
  useEffect(() => {
    currentEvm().then(setEvmAcct);
    return watchEvm(setEvmAcct);
  }, []);
  const [walletLoading, setWalletLoading] = useState(false);
  const [hideHandoff, setHideHandoff] = useState<string | null>(null);
  const editorRef = useRef<EditorApi | null>(null);
  const onDocError = useCallback((m: string) => setNotice(m), []);
  const docs = useDocuments(info, onDocError);
  const { source, setSource } = docs;
  const title = docs.activeTab?.name.replace(/\.cast$/, "") ?? "";
  const handled = useRef(new Set<string>());

  // ---------------------------------------------------------------- boot

  useEffect(() => {
    api.info().then(
      (i) => {
        setInfo(i);
        setNetwork((n) => (i.networks.includes(n) ? n : i.defaultNetwork));
      },
      (e) => setFatal(e.message),
    );
  }, []);

  const keys = info?.keyAccounts[network] ?? [];
  useEffect(() => {
    if (!info) return;
    if (!keys.includes(keyAccount)) setKeyAccount(keys.includes(info.defaultAccount ?? "") ? info.defaultAccount! : keys[0] ?? "");
    if (signer === "key" && keys.length === 0) setSigner("wallet");
  }, [info, network]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => store.set("network", network), [network]);
  useEffect(() => store.set("signer", signer), [signer]);
  useEffect(() => store.set("keyAccount", keyAccount), [keyAccount]);

  useEffect(() => store.set("view", view), [view]);
  useEffect(() => store.set("sideOpen", sideOpen), [sideOpen]);

  // ---------------------------------------------------------------- wallet

  useEffect(() => {
    if (signer !== "wallet") return;
    let stop = () => {};
    let live = true;
    setWalletLoading(true);
    setWalletAcct(null);
    getWallet(network).then(
      (h) => {
        if (!live) return;
        setWallet(h);
        setWalletLoading(false);
        stop = watchAccount(h, setWalletAcct);
      },
      (e) => {
        if (!live) return;
        setWalletLoading(false);
        setNotice(`wallet: ${e.message}`);
      },
    );
    return () => {
      live = false;
      stop();
    };
  }, [signer, network]);

  // With only MetaMask connected, the server uses its NEAR-side (ETH-implicit) account.
  const account = signer === "wallet" ? walletAcct?.accountId ?? (evmAcct ? evmAcct.toLowerCase() : "") : keyAccount;
  const walletId = signer === "wallet" ? walletAcct?.walletId ?? undefined : undefined;
  const evmAccount = evmAcct ?? undefined;
  const ctx = useMemo<Ctx>(() => ({ network, account, signer, walletId, evmAccount }), [network, account, signer, walletId, evmAccount]);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  // A different account, network or signer is a different run: drop the old snapshot.
  useEffect(() => {
    setSnap(null);
    setReviewing(false);
  }, [ctx]);

  // Wallets that redirect (instead of a popup) come back with the result in the URL.
  useEffect(() => {
    if (!info) return;
    const q = new URLSearchParams(location.search);
    const hashes = q.get("transactionHashes");
    const err = q.get("errorCode") ?? q.get("errorMessage");
    if (!hashes && !err) return;
    const pending = store.get<Pending | null>("pendingWallet", null);
    history.replaceState(null, "", location.pathname);
    if (!pending) return;
    store.del("pendingWallet");
    handled.current.add(pending.id);
    session.mark(`wallet:${pending.id}`);
    api.wallet(pending.ctx, pending.hash, pending.id, hashes ? { txHash: hashes.split(",").pop()! } : { error: err ?? "rejected" })
      .then(setSnap, (e) => setNotice(e.message));
  }, [info]);

  // ---------------------------------------------------------------- plan / run

  const plan = useCallback(async (fresh = false): Promise<Snapshot | null> => {
    if (!ctx.account) {
      setNotice(signer === "wallet" ? "Connect a wallet first." : `No local key for ${network}.`);
      return null;
    }
    setPlanning(true);
    setPlanErr(null);
    setNotice(null);
    try {
      const s = await api.plan(ctx, source, fresh);
      setSnap(s);
      setPanelTab("flow");
      return s;
    } catch (e) {
      const err = e as ApiError;
      setPlanErr({ msg: err.message, line: err.line ?? null });
      setPanelTab("problems");
      return null;
    } finally {
      setPlanning(false);
    }
  }, [ctx, source, signer, network]);

  const guard = async (f: () => Promise<Snapshot | void>) => {
    setBusy(true);
    setNotice(null);
    try {
      const s = await f();
      if (s) setSnap(s);
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Poll while something is happening.
  const live = !!snap && (snap.running || !!snap.walletRequest);
  useEffect(() => {
    if (!live || !snap) return;
    const hash = snap.hash;
    const t = setInterval(() => {
      api.state(ctxRef.current, hash).then(setSnap, () => {});
    }, 1000);
    return () => clearInterval(t);
  }, [live, snap?.hash]); // eslint-disable-line react-hooks/exhaustive-deps

  const approve = async () => {
    const req = snap?.walletRequest;
    if (!req || !snap) return;
    if (req.kind === "evm") {
      if (handled.current.has(req.id) || session.has(`wallet:${req.id}`)) return;
      handled.current.add(req.id);
      session.mark(`wallet:${req.id}`);
      let result: { txHash?: string; error?: string };
      try {
        result = { txHash: await sendEvm(req) };
      } catch (e: any) {
        result = { error: e?.message || "rejected in wallet" };
      }
      await guard(() => api.wallet(ctx, snap.hash, req.id, result));
      return;
    }
    if (!wallet) return;
    if (handled.current.has(req.id) || session.has(`wallet:${req.id}`)) return;
    handled.current.add(req.id);
    session.mark(`wallet:${req.id}`);
    const pending: Pending = { id: req.id, hash: snap.hash, ctx };
    store.set("pendingWallet", pending);
    let result: { txHash?: string; error?: string };
    try {
      const txHash = await sendWithWallet(wallet, req);
      if (txHash === null) return; // redirect wallet: the page is leaving; the URL brings the hash back
      result = { txHash };
    } catch (e) {
      result = { error: (e as Error)?.message || "rejected in wallet" };
    }
    store.del("pendingWallet");
    await guard(() => api.wallet(ctx, pending.hash, req.id, result));
  };

  // ---------------------------------------------------------------- editor helpers

  const insert = (e: EntryDoc, what: "usage" | "example") => {
    const ed = editorRef.current;
    if (!ed) return;
    if (what === "example" && e.example) ed.insert(e.example, false);
    else ed.insert(snippetFor(e), true);
  };

  // Switching documents starts from a clean preview.
  useEffect(() => {
    setSnap(null);
    setPlanErr(null);
  }, [docs.active]);

  const saveActive = () => {
    const t = docs.activeTab;
    if (!t || t.kind === "file") return; // files save themselves
    const name = window.prompt("Save as (in the workspace)", t.kind === "example" ? t.name : "script.cast");
    if (name) docs.saveAs(name);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.altKey && e.code === "KeyN") {
        e.preventDefault();
        setView("explorer");
        setSideOpen(true);
        setCreating(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);


  // ---------------------------------------------------------------- render

  const v = snap?.view ?? null;
  const ethWallet = signer === "wallet" && splitsBatches(walletAcct?.walletId ?? null);
  const splitWarning = ethWallet && v?.steps.some((s) => s.atomic && s.signedWith === "wallet")
    ? "MetaMask (NEP-518) sends each action as its own transaction: batches are not atomic."
    : undefined;
  const evmReq = snap?.walletRequest?.kind === "evm" ? snap.walletRequest : null;
  const wrongEvm = evmReq
    ? !evmAcct ? "Connect your EVM wallet (MetaMask) to continue."
      : evmAcct.toLowerCase() !== evmReq.signerId.toLowerCase() ? `MetaMask is on ${evmAcct}; this step needs ${evmReq.signerId}.` : undefined
    : undefined;
  const wrongAccount = evmReq ? wrongEvm : snap?.walletRequest && walletAcct && snap.walletRequest.signerId !== walletAcct.accountId
    ? `Wallet is ${walletAcct.accountId}; this step needs ${snap.walletRequest.signerId}.`
    : snap?.walletRequest && !walletAcct ? "Connect the wallet to continue." : undefined;

  if (fatal) {
    return <div className="h-full flex items-center justify-center text-bad p-6">server: {fatal}</div>;
  }

  // Celebrate the moment a run we watched turns complete (not when opening an old finished run).
  const [party, setParty] = useState<string | null>(null);
  const prevRun = useRef<string | undefined>(undefined);
  useEffect(() => {
    const was = prevRun.current;
    prevRun.current = snap ? `${snap.hash}:${snap.run}:${snap.running}` : undefined;
    if (snap?.run === "complete" && was && was.startsWith(`${snap.hash}:`) && !was.includes(":complete:")) setParty(`${snap.hash}:${Date.now()}`);
  }, [snap?.hash, snap?.run, snap?.running]); // eslint-disable-line react-hooks/exhaustive-deps

  const status = notice ? { text: notice, bad: true } : null;
  const problems = problemsOf(snap, planErr);
  const markers: Marker[] = problems
    .filter((p) => p.line && p.level !== "info")
    .map((p) => ({ line: p.line!, message: p.message, severity: p.level === "error" ? "error" : "warning" }));
  const errors = problems.filter((p) => p.level === "error").length;
  const warnings = problems.filter((p) => p.level === "warning").length;
  const selectView = (vw: View) => {
    if (sideOpen && view === vw) setSideOpen(false);
    else {
      setView(vw);
      setSideOpen(true);
    }
  };
  const actions = {
    review: () => setReviewing(true),
    resume: (retry: boolean) => snap && guard(() => api.resume(ctx, snap.hash, retry)),
    kill: () => snap && guard(async () => void (await api.kill(ctx, snap.hash))),
    fresh: async () => {
      const s = await plan(true);
      if (s?.view && s.run === "none") setReviewing(true);
    },
    approve,
  };

  const editorGroup = (
    <div className="h-full min-h-0 flex flex-col bg-bg">
      <div className="h-[35px] shrink-0 flex bg-panel border-b border-line">
        <div className="flex min-w-0 overflow-x-auto">
          {docs.tabs.map((t) => {
            const on = t.key === docs.active;
            const isDirty = docs.dirty.has(t.key) && t.kind !== "file";
            return (
              <div
                key={t.key}
                onClick={() => docs.activate(t.key)}
                onAuxClick={(e) => e.button === 1 && docs.close(t.key)}
                className={`group relative h-full pl-3 pr-1.5 flex items-center gap-1.5 border-r border-line text-[13px] cursor-pointer shrink-0 ${on ? "bg-bg text-text" : "bg-panel text-dim hover:text-text"}`}
                title={t.kind === "example" ? `${t.name} (example, read-only: ⌘S saves a copy)` : t.name}
              >
                {on && <span className="absolute top-0 left-0 right-0 h-px bg-accent" />}
                <i className={`codicon codicon-file-code ${t.kind === "example" ? "text-dim" : "text-accent"}`} style={{ fontSize: 14 }} />
                <span className={t.kind === "untitled" ? "italic" : ""}>{t.name}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    docs.close(t.key);
                  }}
                  className={`w-5 h-5 flex items-center justify-center rounded hover:bg-white/10 cursor-pointer ${on || isDirty ? "" : "opacity-0 group-hover:opacity-100"}`}
                  aria-label={`Close ${t.name}`}
                >
                  <i className={`codicon ${isDirty ? "codicon-circle-filled group-hover:hidden" : "codicon-close"}`} style={{ fontSize: isDirty ? 10 : 14 }} />
                  {isDirty && <i className="codicon codicon-close hidden group-hover:inline" style={{ fontSize: 14 }} />}
                </button>
              </div>
            );
          })}
        </div>
        <div className="flex-1" />
        <button className="h-full px-2 flex items-center text-text hover:bg-white/10 cursor-pointer" onClick={docs.newUntitled} title="New Untitled Script">
          <i className="codicon codicon-add" />
        </button>
        <button
          className="h-full px-3 flex items-center gap-1 text-text hover:bg-white/10 cursor-pointer disabled:opacity-40"
          onClick={() => plan()}
          disabled={!info || !account || planning || !docs.activeTab}
          title="Simulate (⌘↵): reads the chains, signs nothing"
        >
          <i className={`codicon ${planning ? "codicon-loading codicon-modifier-spin" : "codicon-play"} text-accent`} />
        </button>
      </div>
      <div className="h-[22px] shrink-0 px-3 flex items-center gap-1 text-[12px] text-dim bg-bg">
        {docs.activeTab?.kind === "file" ? (docs.dir.split(/[\\/]/).pop() ?? "scripts") : docs.activeTab?.kind === "example" ? "examples" : "untitled"}
        <i className="codicon codicon-chevron-right" style={{ fontSize: 12 }} /> {docs.activeTab?.name ?? ""}
      </div>
      <div className="flex-1 min-h-0">
        {!docs.activeTab ? (
          <div className="h-full flex flex-col items-center justify-center gap-3 text-dim">
            <i className="codicon codicon-file-code" style={{ fontSize: 64, opacity: 0.25 }} />
            <div>Open a script from the Explorer, or</div>
            <div className="flex gap-2">
              <button className="text-accent hover:underline cursor-pointer" onClick={() => { setView("explorer"); setSideOpen(true); setCreating(true); }}>New File… (⌥⌘N)</button>
            </div>
          </div>
        ) : (
        <Editor
          onSave={saveActive}
          value={source}
          onChange={(s) => {
            setSource(s);
            if (planErr) setPlanErr(null);
          }}
          docs={info?.docs ?? null}
          network={network}
          markers={markers}
          onApi={(a) => (editorRef.current = a)}
          onRun={() => plan()}
          onCursor={(line, col) => setCursor({ line, col })}
        />
        )}
      </div>
    </div>
  );

  const panel = (
    <div className="h-full min-h-0 flex flex-col bg-panel border-t border-line">
      <WalletStrip
        snap={snap}
        walletReady={evmReq ? !!evmAcct && !wrongAccount : !!wallet && !!walletAcct && !wrongAccount}
        walletWarning={wrongAccount ?? splitWarning}
        onApprove={approve}
      />
      <div className="flex-1 min-h-0">
        <Panel tab={panelTab} setTab={setPanelTab} snap={snap} problems={problems} busy={busy || planning} act={actions} onReveal={(l) => editorRef.current?.reveal(l)} />
      </div>
    </div>
  );

  const main = (
    <div data-sash-root className="relative flex-1 min-w-0 min-h-0 flex flex-col">
      <div className="flex-1 min-h-0">{editorGroup}</div>
      <Sash dir="horizontal" min={120} max={() => window.innerHeight - 180} onSize={setPanelH} onReset={() => setPanelH(300)} style={{ bottom: panelH - 3, top: "auto", marginTop: 0 }} />
      <div className="shrink-0 min-h-0" style={{ height: panelH }}>{panel}</div>
    </div>
  );

  if (page === "home") return <Landing onOpen={() => (location.hash = "editor")} />;

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 min-h-0 flex">
        <ActivityBar
          view={view}
          open={sideOpen}
          onSelect={selectView}
          badges={{ run: snap?.walletRequest ? "dot" : snap?.running ? "dot" : undefined }}
        />
        <div data-sash-root className="relative flex-1 min-w-0 min-h-0 flex">
          {sideOpen && (
            <>
              <div className="shrink-0 h-full min-h-0 border-r border-line" style={{ width: sideW }}>
                <SideBar
                  view={view}
                  info={info}
                  explorer={{
                    dir: docs.dir, files: docs.files, examples: info?.examples ?? [], activeKey: docs.active, dirty: docs.dirty,
                    creating, setCreating,
                    onOpenFile: docs.openFile, onOpenExample: docs.openExample, onNewFile: docs.newFile,
                    onRename: docs.rename, onDelete: docs.remove, onRefresh: docs.refresh,
                  }}
                  onInsert={insert}
                  run={{
                    info, network, setNetwork, signer, setSigner, keyAccount, setKeyAccount,
                    walletAccount: walletAcct?.accountId ?? null, walletLoading,
                    onConnect: () => { if (wallet) connect(wallet).catch((e) => setNotice(`wallet: ${e.message}`)); },
                    onDisconnect: () => wallet && disconnect(wallet).catch((e) => setNotice(e.message)),
                    evmAccount: evmAcct, evmAvailable: hasEvmWallet(),
                    onConnectEvm: () => connectEvm().then(setEvmAcct, (e) => setNotice(`evm wallet: ${e.message}`)),
                    snap, planning, busy, canSimulate: !!info && !!account,
                    onSimulate: () => plan(), onReview: () => setReviewing(true),
                  }}
                />
              </div>
              <Sash dir="vertical" min={170} max={() => window.innerWidth * 0.6} onSize={setSideW} onReset={() => setSideW(300)} style={{ left: sideW }} />
            </>
          )}
          {main}
        </div>
      </div>
      <Confetti fire={party} />
      <StatusBar
        network={network}
        onNetwork={() => setNetwork(network === "testnet" ? "mainnet" : "testnet")}
        signer={signer}
        account={account}
        evmAccount={evmAcct}
        onAccount={() => selectView("run")}
        errors={errors}
        warnings={warnings}
        onProblems={() => setPanelTab("problems")}
        cursor={cursor}
        snap={snap}
        message={status}
      />

      {reviewing && v && snap && (
        <ReviewModal
          v={v}
          signer={signer}
          warning={splitWarning}
          busy={busy || planning}
          onClose={() => setReviewing(false)}
          onReplan={() => plan()}
          onConfirm={() =>
            guard(async () => {
              const s = await api.run(ctx, snap.hash, snap.run === "complete");
              setReviewing(false);
              return s;
            })
          }
        />
      )}
      {snap?.handoff && hideHandoff !== snap.handoff.stepId && (
        <HandoffDialog
          h={snap.handoff}
          network={network}
          busy={busy}
          onClose={() => setHideHandoff(snap.handoff!.stepId)}
          onSent={(txHash) => guard(() => api.handoff(ctx, snap.hash, snap.handoff!.stepId, { txHash }))}
          onNotSent={() => guard(() => api.handoff(ctx, snap.hash, snap.handoff!.stepId, { notSent: true }))}
        />
      )}
    </div>
  );
}
