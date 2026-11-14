import { snippet } from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Ctx, EntryDoc, InfoResponse, Network, SignerMode, Snapshot } from "@api";
import { DocsPane } from "./components/DocsPane.tsx";
import { Editor } from "./components/Editor.tsx";
import { HandoffDialog } from "./components/HandoffDialog.tsx";
import { Confetti } from "./components/Confetti.tsx";
import { FlowPanel } from "./components/FlowPanel.tsx";
import { Header } from "./components/Header.tsx";
import { Rail } from "./components/Rail.tsx";
import { ReviewModal } from "./components/ReviewModal.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { api, ApiError } from "./lib/api.ts";
import { snippetFor } from "./lib/completions.ts";
import { session, store } from "./lib/storage.ts";
import { disconnect, getWallet, sendWithWallet, splitsBatches, watchAccount, type WalletAccount, type WalletHandle } from "./lib/wallet.ts";

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
  const [source, setSource] = useState<string>(() => store.get("source", ""));
  const [title, setTitle] = useState<string>(() => store.get("title", "Untitled"));
  const [docsOpen, setDocsOpen] = useState<boolean>(() => store.get("docsOpen", true));
  const [flowOpen, setFlowOpen] = useState<boolean>(() => store.get("flowOpen", true));
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [planErr, setPlanErr] = useState<{ msg: string; line: number | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [wallet, setWallet] = useState<WalletHandle | null>(null);
  const [walletAcct, setWalletAcct] = useState<WalletAccount | null>(null);
  const [walletLoading, setWalletLoading] = useState(false);
  const [hideHandoff, setHideHandoff] = useState<string | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const handled = useRef(new Set<string>());

  // ---------------------------------------------------------------- boot

  useEffect(() => {
    api.info().then(
      (i) => {
        setInfo(i);
        setNetwork((n) => (i.networks.includes(n) ? n : i.defaultNetwork));
        setSource((s) => s || i.initial);
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
  useEffect(() => store.set("title", title), [title]);
  useEffect(() => store.set("docsOpen", docsOpen), [docsOpen]);
  useEffect(() => store.set("flowOpen", flowOpen), [flowOpen]);
  useEffect(() => {
    const t = setTimeout(() => store.set("source", source), 300);
    return () => clearTimeout(t);
  }, [source]);

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

  const account = signer === "wallet" ? walletAcct?.accountId ?? "" : keyAccount;
  const walletId = signer === "wallet" ? walletAcct?.walletId ?? undefined : undefined;
  const ctx = useMemo<Ctx>(() => ({ network, account, signer, walletId }), [network, account, signer, walletId]);
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
      setFlowOpen(true);
      return s;
    } catch (e) {
      const err = e as ApiError;
      setPlanErr({ msg: err.message, line: err.line ?? null });
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
    if (!req || !wallet || !snap) return;
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
    const view = viewRef.current;
    if (!view) return;
    const pos = view.state.selection.main.head;
    const line = view.state.doc.lineAt(pos);
    const atEmpty = line.text.trim() === "";
    const from = atEmpty ? line.from : line.to;
    const prefix = atEmpty ? "" : "\n";
    if (what === "example" && e.example) {
      view.dispatch({ changes: { from, to: atEmpty ? line.to : from, insert: prefix + e.example }, scrollIntoView: true });
    } else {
      const tpl = (prefix + snippetFor(e)).replace(/\t/g, "  ");
      snippet(tpl)({ state: view.state, dispatch: view.dispatch } as any, null, from, atEmpty ? line.to : from);
    }
    view.focus();
  };

  const openExample = (name: string) => {
    const ex = info?.examples.find((x) => x.name === name);
    if (!ex) return;
    setSource(ex.source);
    setTitle(name.replace(/\.cast$/, ""));
    setSnap(null);
    setPlanErr(null);
  };

  // ---------------------------------------------------------------- render

  const v = snap?.view ?? null;
  const ethWallet = signer === "wallet" && splitsBatches(walletAcct?.walletId ?? null);
  const splitWarning = ethWallet && v?.steps.some((s) => s.atomic && s.signedWith === "wallet")
    ? "MetaMask (NEP-518) sends each action as its own transaction: batches are not atomic."
    : undefined;
  const wrongAccount = snap?.walletRequest && walletAcct && snap.walletRequest.signerId !== walletAcct.accountId
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

  const status = planErr
    ? { text: planErr.msg, bad: true }
    : notice
      ? { text: notice, bad: true }
      : null;

  return (
    <div className="h-full flex flex-col">
      <Header
        running={!!snap?.running}
        info={info}
        title={title}
        setTitle={setTitle}
        onExample={openExample}
        onSimulate={() => plan()}
        canSimulate={!!info && !!account}
        planning={planning}
      />
      <div className="flex-1 min-h-0 flex">
        <Rail
          docs={docsOpen}
          flow={flowOpen}
          toggleDocs={() => setDocsOpen((x) => !x)}
          toggleFlow={() => setFlowOpen((x) => !x)}
          flowBadge={snap?.walletRequest ? "wallet" : snap?.running ? "run" : null}
        />
        {docsOpen && (
          <aside className="w-[340px] shrink-0 min-h-0 border-r border-line bg-panel/60">
            <DocsPane docs={info?.docs ?? null} onInsert={insert} />
          </aside>
        )}
        <main className="flex-1 min-w-0 min-h-0 flex flex-col">
          <div className={`min-h-0 overflow-hidden ${flowOpen ? "flex-[1_1_55%]" : "flex-1"}`}>
            <Editor
              value={source}
              onChange={(s) => {
                setSource(s);
                if (planErr) setPlanErr(null);
              }}
              docs={info?.docs ?? null}
              network={network}
              errorLine={planErr?.line ?? null}
              onView={(view) => (viewRef.current = view)}
              onRun={() => plan()}
            />
          </div>
          {flowOpen && (
            <section className="flex-[1_1_45%] min-h-[220px] border-t border-line bg-panel/40">
              <FlowPanel
                snap={snap}
                busy={busy || planning}
                walletReady={!!wallet && !!walletAcct && !wrongAccount}
                walletWarning={wrongAccount ?? splitWarning}
                act={{
                  review: () => setReviewing(true),
                  resume: (retry) => snap && guard(() => api.resume(ctx, snap.hash, retry)),
                  kill: () => snap && guard(async () => void (await api.kill(ctx, snap.hash))),
                  fresh: async () => {
                    const s = await plan(true);
                    if (s?.view && s.run === "none") setReviewing(true);
                  },
                  approve,
                }}
              />
            </section>
          )}
        </main>
      </div>
      <Confetti fire={party} />
      <StatusBar
        info={info}
        network={network}
        setNetwork={setNetwork}
        signer={signer}
        setSigner={setSigner}
        keyAccount={keyAccount}
        setKeyAccount={setKeyAccount}
        walletAccount={walletAcct?.accountId ?? null}
        walletLoading={walletLoading}
        onConnect={() => wallet?.modal.show()}
        onDisconnect={() => wallet && disconnect(wallet).catch((e) => setNotice(e.message))}
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
