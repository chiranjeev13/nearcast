import { useMemo, useState } from "react";
import {
  VscodeButton,
  VscodeCollapsible,
  VscodeFormGroup,
  VscodeLabel,
  VscodeOption,
  VscodeSingleSelect,
  VscodeTextfield,
} from "@vscode-elements/react-elements";
import type { Docs, EntryDoc, FileEntry, InfoResponse, Network, SignerMode, Snapshot } from "@api";
import type { View } from "./ActivityBar.tsx";
import { short } from "./ui.tsx";

const TITLE: Record<View, string> = { explorer: "Explorer", docs: "Docs", run: "Run and Simulate" };

function Header({ view }: { view: View }) {
  return (
    <div className="h-[35px] shrink-0 px-5 flex items-center text-[11px] uppercase tracking-[0.04em] text-text">
      {TITLE[view]}
    </div>
  );
}

// ---------------------------------------------------------------- explorer

export interface ExplorerProps {
  dir: string;
  files: FileEntry[];
  examples: { name: string }[];
  activeKey: string;
  dirty: Set<string>;
  creating: boolean;
  setCreating: (v: boolean) => void;
  onOpenFile: (name: string) => void;
  onOpenExample: (name: string) => void;
  onNewFile: (name: string) => Promise<boolean>;
  onRename: (from: string, to: string) => void;
  onDelete: (name: string) => void;
  onRefresh: () => void;
}

function IconButton({ icon, title, onClick }: { icon: string; title: string; onClick: () => void }) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="w-[22px] h-[22px] flex items-center justify-center rounded hover:bg-[#5a5d5e50] cursor-pointer text-text"
    >
      <i className={`codicon ${icon}`} />
    </button>
  );
}

function NewFileInput({ onDone }: { onDone: (name: string | null) => void }) {
  const [v, setV] = useState("");
  return (
    <div className="flex items-center gap-1 h-[22px] pl-[22px] pr-2">
      <i className="codicon codicon-file-code text-accent" />
      <input
        autoFocus
        value={v}
        placeholder="name.cast"
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && v.trim()) onDone(v.trim());
          if (e.key === "Escape") onDone(null);
        }}
        onBlur={() => onDone(v.trim() || null)}
        className="flex-1 min-w-0 h-[20px] px-1 bg-[#313131] border border-accent outline-none text-[13px] text-text"
      />
    </div>
  );
}

function Explorer(p: ExplorerProps) {
  const folder = p.dir.split(/[\\/]/).filter(Boolean).pop() ?? "scripts";
  const row = (key: string, isActive: boolean) =>
    `group w-full h-[22px] pl-[22px] pr-2 flex items-center gap-1.5 text-left cursor-pointer ${isActive ? "bg-[#37373d]" : "hover:bg-[#2a2d2e]"}`;
  return (
    <div className="flex flex-col min-h-0 overflow-y-auto">
      <VscodeCollapsible title={folder} open>
        <div slot="actions" className="flex items-center">
          <IconButton icon="codicon-new-file" title="New File… (⌥⌘N)" onClick={() => p.setCreating(true)} />
          <IconButton icon="codicon-refresh" title="Refresh Explorer" onClick={p.onRefresh} />
        </div>
        <div className="pb-1">
          {p.creating && (
            <NewFileInput
              onDone={async (name) => {
                if (name) await p.onNewFile(name);
                p.setCreating(false);
              }}
            />
          )}
          {p.files.length === 0 && !p.creating && (
            <div className="px-5 py-2 text-[12px] text-dim flex flex-col gap-2">
              <span>No scripts yet in {p.dir || "the workspace"}.</span>
              <VscodeButton onClick={() => p.setCreating(true)}>New File</VscodeButton>
            </div>
          )}
          {p.files.map((f) => {
            const key = `file:${f.name}`;
            return (
              <div key={f.name} className={row(key, p.activeKey === key)} onClick={() => p.onOpenFile(f.name)} title={`${p.dir}/${f.name}`}>
                <i className="codicon codicon-file-code text-accent" />
                <span className="flex-1 min-w-0 truncate text-[13px]">{f.name}</span>
                {p.dirty.has(key) && <span className="w-2 h-2 rounded-full bg-text/70" title="saving…" />}
                <span className="hidden group-hover:flex">
                  <IconButton
                    icon="codicon-edit"
                    title="Rename…"
                    onClick={() => {
                      const to = window.prompt(`Rename ${f.name} to`, f.name);
                      if (to && to !== f.name) p.onRename(f.name, to);
                    }}
                  />
                  <IconButton
                    icon="codicon-trash"
                    title="Delete"
                    onClick={() => {
                      if (window.confirm(`Delete ${f.name}? This cannot be undone.`)) p.onDelete(f.name);
                    }}
                  />
                </span>
              </div>
            );
          })}
        </div>
      </VscodeCollapsible>
      <VscodeCollapsible title="Examples" description="read-only" open>
        <div className="pb-1">
          {p.examples.map((x) => {
            const key = `example:${x.name}`;
            return (
              <div key={x.name} className={row(key, p.activeKey === key)} onClick={() => p.onOpenExample(x.name)}>
                <i className="codicon codicon-file-code text-dim" />
                <span className="flex-1 min-w-0 truncate text-[13px]">{x.name}</span>
                <i className="codicon codicon-lock text-faint" style={{ fontSize: 12 }} />
              </div>
            );
          })}
        </div>
      </VscodeCollapsible>
    </div>
  );
}

// ---------------------------------------------------------------- docs

const KIND_ICON: Record<EntryDoc["kind"], string> = { command: "codicon-symbol-method", helper: "codicon-symbol-function", keyword: "codicon-symbol-keyword" };

function DocsView({ docs, onInsert }: { docs: Docs | null; onInsert: (e: EntryDoc, what: "usage" | "example") => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const groups = useMemo(() => {
    if (!docs) return [];
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (e: EntryDoc) => words.every((w) => `${e.insert} ${e.module} ${e.summary} ${e.chains?.join(" ") ?? ""}`.toLowerCase().includes(w));
    const mods = [{ name: "", summary: "Language" }, ...docs.modules];
    return mods
      .map((m) => ({ m, entries: docs.entries.filter((e) => e.module === m.name && hit(e)) }))
      .filter((g) => g.entries.length);
  }, [docs, q]);
  if (!docs) return <div className="px-5 text-dim">loading…</div>;
  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="px-3 pb-2">
        <VscodeTextfield
          placeholder="Search commands & helpers"
          value={q}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          className="w-full"
        >
          <i slot="content-before" className="codicon codicon-search" />
        </VscodeTextfield>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {groups.map(({ m, entries }) => (
          <VscodeCollapsible key={m.name || "lang"} title={m.name ? `${m.name}${m.name === "std" ? " (built in)" : ""}` : "language"} description={String(entries.length)} open={!!q || m.name === "std" || m.name === ""}>
            <div className="pb-1">
              {entries.map((e) => {
                const id = `${e.kind}:${e.insert}`;
                const isOpen = open === id;
                return (
                  <div key={id}>
                    <button
                      onClick={() => setOpen(isOpen ? null : id)}
                      className={`w-full h-[22px] pl-5 pr-3 flex items-center gap-1.5 text-left cursor-pointer ${isOpen ? "bg-[#37373d]" : "hover:bg-[#2a2d2e]"}`}
                      title={e.usage}
                    >
                      <i className={`codicon ${KIND_ICON[e.kind]} ${e.kind === "helper" ? "text-helper" : e.kind === "keyword" ? "text-[#c586c0]" : "text-accent"}`} />
                      <span className="font-mono text-[12px] truncate">{e.insert}</span>
                      <span className="text-faint text-[12px] truncate">{e.summary}</span>
                    </button>
                    {isOpen && (
                      <div className="pl-10 pr-3 py-2 flex flex-col gap-2 text-[12px] bg-[#1f1f1f] border-y border-line">
                        <code className="text-accent whitespace-pre-wrap break-words">{e.usage}</code>
                        <div>{e.summary}</div>
                        {e.details && <div className="text-dim">{e.details}</div>}
                        {e.opts?.map((o) => (
                          <div key={o.name} className="text-dim">
                            <code className="text-opt">--{o.name}{o.value ? ` ${o.value}` : ""}</code> {o.summary}
                          </div>
                        ))}
                        {e.example && <pre className="m-0 p-2 bg-panel border border-line text-[11.5px] whitespace-pre-wrap">{e.example}</pre>}
                        <div className="flex gap-2">
                          <VscodeButton onClick={() => onInsert(e, "usage")}>Insert</VscodeButton>
                          {e.example && <VscodeButton secondary onClick={() => onInsert(e, "example")}>Insert example</VscodeButton>}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </VscodeCollapsible>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- run

export interface RunProps {
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
  evmAccount: string | null;
  evmAvailable: boolean;
  onConnectEvm: () => void;
  snap: Snapshot | null;
  planning: boolean;
  busy: boolean;
  canSimulate: boolean;
  onSimulate: () => void;
  onReview: () => void;
}

function RunView(p: RunProps) {
  const keys = p.info?.keyAccounts[p.network] ?? [];
  const v = p.snap?.view;
  const canRun = !!v && p.snap?.run === "none" && !v.problems.length && v.txCount > 0 && !p.busy;
  const sel = (e: Event) => (e.target as HTMLSelectElement).value;
  return (
    <div className="px-5 flex flex-col gap-3 overflow-y-auto">
      <VscodeButton onClick={p.onSimulate} disabled={!p.canSimulate || p.planning} className="w-full">
        <i slot="content-before" className="codicon codicon-play" />
        {p.planning ? "Simulating…" : "Simulate (⌘↵)"}
      </VscodeButton>
      <VscodeButton secondary onClick={p.onReview} disabled={!canRun} className="w-full">
        <i slot="content-before" className="codicon codicon-rocket" />
        Review & execute
      </VscodeButton>
      <div className="text-[12px] text-dim">Simulate reads the chains and signs nothing. Execute asks for confirmation.</div>

      <VscodeFormGroup variant="vertical">
        <VscodeLabel>Network</VscodeLabel>
        <VscodeSingleSelect value={p.network} onChange={(e) => p.setNetwork(sel(e as unknown as Event) as Network)}>
          {(p.info?.networks ?? ["testnet", "mainnet"]).map((n) => <VscodeOption key={n} value={n}>{n}</VscodeOption>)}
        </VscodeSingleSelect>
      </VscodeFormGroup>

      {keys.length > 0 && <VscodeFormGroup variant="vertical">
        <VscodeLabel>Signer</VscodeLabel>
        <VscodeSingleSelect value={p.signer} onChange={(e) => p.setSigner(sel(e as unknown as Event) as SignerMode)}>
          <VscodeOption value="key" disabled={!keys.length}>local key{keys.length ? "" : " (none on this network)"}</VscodeOption>
          <VscodeOption value="wallet">browser wallet</VscodeOption>
        </VscodeSingleSelect>
      </VscodeFormGroup>}

      <VscodeFormGroup variant="vertical">
        <VscodeLabel>NEAR wallet</VscodeLabel>
        {p.signer === "key" ? (
          <VscodeSingleSelect value={p.keyAccount} onChange={(e) => p.setKeyAccount(sel(e as unknown as Event))}>
            {keys.map((k) => <VscodeOption key={k} value={k}>{short(k, 12)}</VscodeOption>)}
          </VscodeSingleSelect>
        ) : p.walletAccount ? (
          <div className="flex items-center gap-2">
            <span className="font-mono text-[12px] truncate flex-1" title={p.walletAccount}>{p.walletAccount}</span>
            <VscodeButton secondary onClick={p.onDisconnect}>Disconnect</VscodeButton>
          </div>
        ) : (
          <VscodeButton secondary onClick={p.onConnect} disabled={p.walletLoading}>{p.walletLoading ? "Loading wallets…" : "Connect NEAR wallet"}</VscodeButton>
        )}
      </VscodeFormGroup>

      <VscodeFormGroup variant="vertical">
        <VscodeLabel>EVM wallet (for --from-wallet)</VscodeLabel>
        {!p.evmAvailable ? (
          <div className="text-[12px] text-dim">No EVM wallet in this browser.</div>
        ) : p.evmAccount ? (
          <span className="font-mono text-[12px] truncate" title={p.evmAccount}>{p.evmAccount}</span>
        ) : (
          <VscodeButton secondary onClick={p.onConnectEvm}>Connect MetaMask</VscodeButton>
        )}
      </VscodeFormGroup>
    </div>
  );
}

// ---------------------------------------------------------------- side bar

export function SideBar(p: {
  view: View;
  info: InfoResponse | null;
  explorer: ExplorerProps;
  onInsert: (e: EntryDoc, what: "usage" | "example") => void;
  run: RunProps;
}) {
  return (
    <div className="h-full min-h-0 flex flex-col bg-panel">
      <Header view={p.view} />
      <div className="flex-1 min-h-0 flex flex-col">
        {p.view === "explorer" && <Explorer {...p.explorer} />}
        {p.view === "docs" && <DocsView docs={p.info?.docs ?? null} onInsert={p.onInsert} />}
        {p.view === "run" && <RunView {...p.run} />}
      </div>
    </div>
  );
}
