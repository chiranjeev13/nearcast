export type View = "explorer" | "docs" | "run";

const ITEMS: { id: View; icon: string; title: string }[] = [
  { id: "explorer", icon: "codicon-files", title: "Explorer" },
  { id: "docs", icon: "codicon-book", title: "Docs: commands & helpers" },
  { id: "run", icon: "codicon-debug-alt", title: "Run and Simulate" },
];

/** VS Code's activity bar: click a view to show it, click it again to hide the side bar. */
export function ActivityBar({ view, open, onSelect, badges }: {
  view: View;
  open: boolean;
  onSelect: (v: View) => void;
  badges: Partial<Record<View, number | "dot">>;
}) {
  return (
    <nav className="w-12 shrink-0 flex flex-col bg-panel border-r border-line">
      {ITEMS.map((it) => {
        const active = open && view === it.id;
        const badge = badges[it.id];
        return (
          <button
            key={it.id}
            title={it.title}
            aria-label={it.title}
            aria-pressed={active}
            onClick={() => onSelect(it.id)}
            className={`relative h-12 flex items-center justify-center cursor-pointer ${active ? "text-text" : "text-faint hover:text-text"}`}
          >
            {active && <span className="absolute left-0 top-0 bottom-0 w-[2px] bg-accent" />}
            <i className={`codicon ${it.icon}`} style={{ fontSize: 24 }} />
            {badge !== undefined && badge !== 0 && (
              <span className="absolute bottom-2 right-2 min-w-4 h-4 px-1 rounded-full bg-accent text-accent-ink text-[9px] font-bold flex items-center justify-center">
                {badge === "dot" ? "" : badge}
              </span>
            )}
          </button>
        );
      })}
      <div className="flex-1" />
    </nav>
  );
}
