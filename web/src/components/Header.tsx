import type { InfoResponse } from "@api";
import { Button } from "./ui.tsx";

/** Thin top bar: brand, the open script as a file tab, examples, Simulate. */
export function Header(p: {
  running?: boolean;
  info: InfoResponse | null;
  title: string;
  setTitle: (t: string) => void;
  onExample: (name: string) => void;
  onSimulate: () => void;
  canSimulate: boolean;
  planning: boolean;
}) {
  return (
    <header className="h-11 shrink-0 flex items-stretch border-b border-line bg-panel">
      <div className="w-12 shrink-0 flex items-center justify-center border-r border-line" title="nearcast">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className={`text-accent logo-beat ${p.running ? "fast" : ""}`}>
          <path d="M4 12h6l2-7 2 14 2-7h4" />
        </svg>
      </div>
      <div className="flex items-stretch">
        <label className="flex items-center gap-2 px-4 border-r border-line bg-bg border-t-2 border-t-accent -mb-px cursor-text">
          <span className="text-faint text-[11px] font-mono">cast</span>
          <input
            value={p.title}
            onChange={(e) => p.setTitle(e.target.value)}
            spellCheck={false}
            size={Math.max(8, p.title.length)}
            className="bg-transparent outline-none text-[13px] text-text font-medium"
            aria-label="Script name"
          />
        </label>
        {p.info && p.info.examples.length > 0 && (
          <select
            value=""
            onChange={(e) => e.target.value && p.onExample(e.target.value)}
            className="px-3 bg-transparent text-dim text-[12px] outline-none cursor-pointer hover:text-text"
            aria-label="Open an example"
          >
            <option value="">+ open example</option>
            {p.info.examples.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
          </select>
        )}
      </div>
      <div className="flex-1" />
      <div className="flex items-center px-3">
        <Button variant="primary" onClick={p.onSimulate} disabled={!p.canSimulate || p.planning} title="Dry run: reads chains, signs nothing (⌘↵)">
          {p.planning ? "Simulating…" : <>▶ Simulate <span className="opacity-60 font-normal ml-1">⌘↵</span></>}
        </Button>
      </div>
    </header>
  );
}
