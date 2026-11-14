import { VscodeBadge, VscodeTabHeader, VscodeTabPanel, VscodeTabs } from "@vscode-elements/react-elements";
import type { Snapshot } from "@api";
import { FlowView, PanelActions, type FlowActions } from "./FlowPanel.tsx";

export type PanelTab = "problems" | "output" | "flow";
const TABS: PanelTab[] = ["problems", "output", "flow"];

export interface Problem {
  level: "error" | "warning" | "info";
  message: string;
  line?: number;
}

/** Plan checks and blocking problems as VS Code "Problems" (with line numbers when the message has one). */
export function problemsOf(snap: Snapshot | null, planErr: { msg: string; line: number | null } | null): Problem[] {
  const out: Problem[] = [];
  if (planErr) out.push({ level: "error", message: planErr.msg.replace(/^line \d+: /, ""), line: planErr.line ?? undefined });
  const v = snap?.view;
  if (!v) return out;
  const lineOf = (s: string) => Number(/^line (\d+):/.exec(s)?.[1]) || undefined;
  const seen = new Set<string>();
  for (const c of v.checks) {
    seen.add(c.description);
    if (c.level === "ok") continue;
    out.push({ level: c.level === "fail" ? "error" : "warning", message: c.description.replace(/^line \d+: /, ""), line: lineOf(c.description) });
  }
  for (const p of v.problems) if (!seen.has(p)) out.push({ level: "error", message: p.replace(/^line \d+: /, ""), line: lineOf(p) });
  for (const c of v.checks) if (c.level === "ok") out.push({ level: "info", message: c.description, line: lineOf(c.description) });
  return out;
}

const ICON = { error: "codicon-error text-bad", warning: "codicon-warning text-warn", info: "codicon-pass text-accent" } as const;

export function Panel({ tab, setTab, snap, problems, busy, act, onReveal }: {
  tab: PanelTab;
  setTab: (t: PanelTab) => void;
  snap: Snapshot | null;
  problems: Problem[];
  busy: boolean;
  act: FlowActions;
  onReveal: (line: number) => void;
}) {
  const errs = problems.filter((p) => p.level !== "info").length;
  const v = snap?.view;
  const lines = [...(v?.prints ?? []).map((p) => `› ${p}`), ...(snap?.log ?? [])];
  return (
    <VscodeTabs
      panel
      selectedIndex={TABS.indexOf(tab)}
      onVscTabsSelect={(e) => setTab(TABS[e.detail.selectedIndex])}
      className="h-full"
    >
      <VscodeTabHeader slot="header">
        Problems{errs > 0 && <VscodeBadge variant="counter" slot="content-after">{errs}</VscodeBadge>}
      </VscodeTabHeader>
      <VscodeTabPanel panel>
        <div className="h-full overflow-y-auto py-1">
          {problems.length === 0 && <div className="px-4 py-1 text-dim">No problems have been detected in the plan.</div>}
          {problems.map((p, i) => (
            <button
              key={i}
              onClick={() => p.line && onReveal(p.line)}
              className={`w-full flex items-start gap-2 px-4 py-[3px] text-left text-[13px] hover:bg-[#2a2d2e] ${p.line ? "cursor-pointer" : "cursor-default"}`}
            >
              <i className={`codicon ${ICON[p.level]} mt-[2px]`} />
              <span className={`flex-1 ${p.level === "info" ? "text-dim" : ""}`}>{p.message}</span>
              {p.line && <span className="text-faint shrink-0">[Ln {p.line}]</span>}
            </button>
          ))}
        </div>
      </VscodeTabPanel>

      <VscodeTabHeader slot="header">Output</VscodeTabHeader>
      <VscodeTabPanel panel>
        <pre className="h-full m-0 overflow-y-auto px-4 py-2 font-mono text-[12px] whitespace-pre-wrap break-all">
          {lines.length ? lines.join("\n") : <span className="text-dim">Prints and the run log appear here.</span>}
        </pre>
      </VscodeTabPanel>

      <VscodeTabHeader slot="header">
        Flow
        {snap?.running && <i slot="content-after" className="codicon codicon-loading codicon-modifier-spin text-accent" style={{ fontSize: 12 }} />}
      </VscodeTabHeader>
      <VscodeTabPanel panel>
        <FlowView snap={snap} />
      </VscodeTabPanel>

      <div slot="addons" className="h-full">
        <PanelActions snap={snap} busy={busy} act={act} />
      </div>
    </VscodeTabs>
  );
}
