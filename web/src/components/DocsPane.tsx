import { useMemo, useState } from "react";
import type { Docs, EntryDoc } from "@api";

const TAG: Record<EntryDoc["kind"], string> = { command: "cmd", helper: "helper", keyword: "kw" };

export function DocsPane({ docs, onInsert }: { docs: Docs | null; onInsert: (e: EntryDoc, what: "usage" | "example") => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const list = useMemo(() => {
    if (!docs) return [];
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return docs.entries.filter((e) => {
      const hay = `${e.insert} ${e.module} ${e.summary} ${e.chains?.join(" ") ?? ""}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [docs, q]);

  if (!docs) return <div className="p-5 text-dim">loading…</div>;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="p-4 pb-3">
        <div className="flex items-center gap-2 h-10 px-3 border border-line-2 rounded-[3px] focus-within:border-dim">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-dim shrink-0"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search commands & helpers"
            className="flex-1 bg-transparent outline-none placeholder:text-faint"
          />
          {q && <button className="text-dim hover:text-text cursor-pointer" onClick={() => setQ("")}>×</button>}
        </div>
        <div className="text-faint text-[11px] mt-2">{list.length} of {docs.entries.length}</div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4 flex flex-col gap-2">
        {list.map((e) => {
          const id = `${e.kind}:${e.insert}`;
          const isOpen = open === id;
          return (
            <div key={id} className={`border rounded-[3px] ${isOpen ? "border-line-2 bg-panel" : "border-line hover:border-line-2"}`}>
              <button className="w-full text-left px-4 py-3 cursor-pointer" onClick={() => setOpen(isOpen ? null : id)}>
                <div className="flex items-baseline gap-2 min-w-0">
                  <span className={`font-mono font-semibold truncate ${e.kind === "helper" ? "text-helper" : ""}`}>{e.insert}</span>
                  <span className="text-accent text-[11px] shrink-0">{TAG[e.kind]}</span>
                  {e.module && e.module !== "std" && <span className="text-dim text-[11px] shrink-0">{e.module}</span>}
                </div>
                <div className={`text-dim text-[12px] mt-1 ${isOpen ? "" : "truncate"}`}>{e.summary}</div>
              </button>
              {isOpen && (
                <div className="px-4 pb-4 flex flex-col gap-3 text-[12px]">
                  <code className="text-accent break-words">{e.usage}</code>
                  {e.details && <div className="text-dim leading-relaxed">{e.details}</div>}
                  {e.opts && e.opts.length > 0 && (
                    <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                      {e.opts.map((o) => (
                        <div key={o.name} className="contents">
                          <span className="text-opt whitespace-nowrap">--{o.name}{o.value ? ` ${o.value}` : ""}</span>
                          <span className="text-dim">{o.summary}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {e.chains && e.chains.length > 0 && <div className="text-faint">{e.chains.join(" · ")}</div>}
                  {e.example && <pre className="m-0 p-3 bg-bg border border-line whitespace-pre-wrap break-words">{e.example}</pre>}
                  <div className="flex gap-3">
                    <button className="text-accent hover:underline cursor-pointer" onClick={() => onInsert(e, "usage")}>insert</button>
                    {e.example && <button className="text-dim hover:text-text cursor-pointer" onClick={() => onInsert(e, "example")}>insert example</button>}
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {list.length === 0 && <div className="text-dim px-1">No match.</div>}
      </div>
    </div>
  );
}
