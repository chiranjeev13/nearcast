import { useState, type ButtonHTMLAttributes, type ReactNode } from "react";

type Variant = "primary" | "ghost" | "danger" | "outline";

export function Button({ variant = "outline", className = "", ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  const v = {
    primary: "bg-accent text-accent-ink border-transparent hover:bg-[#6bff52] font-medium",
    outline: "bg-[#313131] border-transparent text-text hover:bg-[#3c3c3c]",
    ghost: "border-transparent text-dim hover:text-text",
    danger: "border-bad/60 text-bad hover:border-bad",
  }[variant];
  return (
    <button
      {...p}
      className={`h-[26px] px-3 border rounded-[2px] text-[12px] whitespace-nowrap transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer ${v} ${className}`}
    />
  );
}

export function Seg<T extends string>({ value, options, onChange, tone }: {
  value: T;
  options: { value: T; label: string; disabled?: boolean; title?: string }[];
  onChange: (v: T) => void;
  tone?: (v: T) => string | undefined;
}) {
  return (
    <div className="flex h-8 border border-line-2 rounded-[3px] overflow-hidden">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            disabled={o.disabled}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={`px-3 text-[12px] cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed ${
              on ? `bg-panel-2 ${tone?.(o.value) ?? "text-accent"}` : "text-dim hover:text-text"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="text-accent text-[11px] ml-2 cursor-pointer hover:underline"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        }, () => {});
      }}
    >
      {done ? "copied" : "copy"}
    </button>
  );
}

export const short = (s: string, n = 6) => (s.length > n * 2 + 3 ? `${s.slice(0, n)}…${s.slice(-4)}` : s);

/** Long hex/base58 identifiers in a value get a copy button. */
export function Value({ text }: { text: string }) {
  const id = /(0x[0-9a-fA-F]{16,}|[0-9a-f]{64}|[1-9A-HJ-NP-Za-km-z]{32,})/.exec(text)?.[1];
  return (
    <span className="break-all font-mono text-[11.5px]">
      {text}
      {id && <Copy text={id} />}
    </span>
  );
}

export function Modal({ children, onClose, wide }: { children: ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-start justify-center p-4 pt-[10vh] overflow-y-auto" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`w-full ${wide ? "max-w-[720px]" : "max-w-[460px]"} bg-[#1f1f1f] border border-[#454545] rounded-md shadow-[0_0_8px_2px_#0000005c] overflow-hidden`}>{children}</div>
    </div>
  );
}

export function ModalHead({ title, sub, onClose }: { title: string; sub?: string; onClose: () => void }) {
  return (
    <div className="flex items-start justify-between px-6 pt-5 pb-4 border-b border-line">
      <div>
        <div className="text-[20px] font-bold">{title}</div>
        {sub && <div className="text-dim mt-1">{sub}</div>}
      </div>
      <button onClick={onClose} className="text-dim hover:text-text text-[20px] leading-none cursor-pointer" aria-label="Close">×</button>
    </div>
  );
}
