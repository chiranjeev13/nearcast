/** Vertical icon rail: toggles the docs drawer and the flow panel. */
export function Rail({ docs, flow, toggleDocs, toggleFlow, flowBadge }: {
  docs: boolean;
  flow: boolean;
  toggleDocs: () => void;
  toggleFlow: () => void;
  flowBadge?: "run" | "wallet" | null;
}) {
  const item = (on: boolean, onClick: () => void, label: string, icon: React.ReactNode, badge?: React.ReactNode) => (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={on}
      className={`wiggle-hover relative w-12 h-12 flex items-center justify-center cursor-pointer ${on ? "text-text" : "text-faint hover:text-dim"}`}
    >
      {on && <span className="absolute left-0 top-2.5 bottom-2.5 w-[2px] bg-accent rounded-r shadow-[0_0_8px_#39ff14]" />}
      {icon}
      {badge}
    </button>
  );
  return (
    <nav className="w-12 shrink-0 flex flex-col border-r border-line bg-panel">
      {item(docs, toggleDocs, "Docs (commands & helpers)", (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z" /><path d="M4 19V5M8 7h7M8 11h5" /></svg>
      ))}
      {item(flow, toggleFlow, "Flow (plan & run)", (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="5" cy="6" r="2" /><circle cx="12" cy="18" r="2" /><circle cx="19" cy="8" r="2" /><path d="M6.5 7.5 11 16.5M13.5 16.5 18 9.5" /></svg>
      ), flowBadge && <span className={`absolute top-3 right-3 w-1.5 h-1.5 rounded-full ${flowBadge === "wallet" ? "bg-warn" : "bg-accent animate-pulse"}`} />)}
    </nav>
  );
}
