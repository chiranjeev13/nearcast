import { useEffect, useRef, useState } from "react";
import { Lockup, Mark } from "./Logo.tsx";

/**
 * The front page. Split hero: what Nearcast is on the left; on the right a small editor types a
 * script, then a flow strip runs its plan across chains. White type, neon green only for state.
 */

const SANS = '"Geist", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const MONO = '"JetBrains Mono", Menlo, Consolas, monospace';
const GREEN = "#39ff14";

type Seg = [cls: "c" | "k" | "f" | "h" | "s" | "n" | "t", text: string];

/** The sample script, one array of (color, text) pairs per line. */
const SAMPLE: Seg[][] = [
  [["k", "load"], ["t", " token"]],
  [["k", "load"], ["t", " chainsig"]],
  [],
  [["k", "assert"], ["t", " "], ["h", "@chainsig:balance"], ["t", "(base "], ["s", '"treasury"'], ["t", " USDC) >= "], ["n", "1e6"]],
  [],
  [["f", "token:transfer"], ["t", " USDC alice.testnet "], ["n", "1"]],
  [["f", "chainsig:on"], ["t", " base "], ["s", '"treasury"'], ["t", " ("]],
  [["t", "  "], ["f", "exec"], ["t", " "], ["h", "@token"], ["t", "(USDC) "], ["s", '"transfer(address,uint256)"'], ["t", " $bob "], ["n", "1e6"]],
  [["t", ")"]],
];
const COLOR: Record<Seg[0], string> = { c: "#6a9955", k: "#c586c0", f: "#4ec9b0", h: "#dcdcaa", s: "#ce9178", n: "#b5cea8", t: "#d4d4d4" };
const LEN = SAMPLE.map((l) => l.reduce((m, [, x]) => m + x.length, 0));
const TOTAL = LEN.reduce((a, b) => a + b + 1, 0);
const FLAT = SAMPLE.map((l) => l.map(([, x]) => x).join("") + "\n").join("");

/** The plan the sample produces, as the editor's Flow panel shows it. */
const FLOW = [
  { lane: 0, label: "check balance" },
  { lane: 1, label: "pay alice" },
  { lane: 1, label: "MPC signs" },
  { lane: 2, label: "pay bob" },
];
const LANES = ["checks", "NEAR", "Base"];

const reduceMotion = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function useTyping(start: boolean, run: number) {
  const [shown, setShown] = useState(reduceMotion() ? TOTAL : 0);
  useEffect(() => {
    if (!start || reduceMotion()) return;
    setShown(0);
    let n = 0;
    let t: ReturnType<typeof setTimeout>;
    const tick = () => {
      n++;
      setShown(n);
      if (n >= TOTAL) return;
      const ch = FLAT[n - 1];
      t = setTimeout(tick, ch === "\n" ? 240 : ch === " " ? 16 : 30);
    };
    t = setTimeout(tick, 500);
    return () => clearTimeout(t);
  }, [start, run]);
  return shown;
}

function Editor({ shown }: { shown: number }) {
  const cursor = <span key="cursor" className="inline-block w-[2px] h-[1.2em] align-[-0.25em]" style={{ background: GREEN, animation: "blink 1s steps(1) infinite" }} />;
  let rest = shown;
  let placed = false;
  const lines = SAMPLE.map((line, i) => {
    let take = Math.max(0, Math.min(LEN[i], rest));
    const out: React.ReactNode[] = [];
    line.forEach(([cls, text], j) => {
      if (take <= 0) return;
      const part = text.slice(0, take);
      take -= part.length;
      out.push(<span key={j} style={{ color: COLOR[cls] }}>{part}</span>);
    });
    if (!placed && (rest <= LEN[i] || i === SAMPLE.length - 1)) {
      out.push(cursor);
      placed = true;
    }
    rest -= LEN[i] + 1;
    return (
      <div key={i} className="flex">
        <span className="w-8 shrink-0 pr-3 text-right select-none text-[#5a5f6a]">{i + 1}</span>
        <span className="whitespace-pre">{out}</span>
      </div>
    );
  });
  return (
    <pre className="m-0 py-3 text-[12.5px] leading-[1.7] overflow-x-auto" style={{ fontFamily: MONO }} aria-label="Example Nearcast script">
      {lines}
    </pre>
  );
}

/** After the typing: the plan runs step by step across the chain lanes. */
function Flow({ go, run }: { go: boolean; run: number }) {
  const [done, setDone] = useState(reduceMotion() ? FLOW.length : 0);
  useEffect(() => {
    if (!go || reduceMotion()) return;
    setDone(0);
    const ts = FLOW.map((_, i) => setTimeout(() => setDone(i + 1), 700 + i * 650));
    return () => ts.forEach(clearTimeout);
  }, [go, run]);
  const W = 64;
  const H = 26;
  const x = (i: number) => 76 + i * W + W / 2;
  const y = (lane: number) => 14 + lane * H;
  return (
    <div className="border-t border-[#23262d] px-3 py-3">
      <div className="flex items-center justify-between mb-2 text-[11px] text-[#8b919c]" style={{ fontFamily: SANS }}>
        <span>Flow</span>
        <span>{done === FLOW.length ? <span style={{ color: GREEN }}>4/4 confirmed</span> : go ? `running ${done}/4` : "simulated · nothing signed"}</span>
      </div>
      <svg viewBox={`0 0 ${76 + FLOW.length * W + 8} ${LANES.length * H + 4}`} className="w-full h-auto" role="img" aria-label="Plan steps across checks, NEAR and Base">
        {LANES.map((l, i) => (
          <g key={l}>
            <text x="4" y={y(i) + 4} fontSize="10" fill="#8b919c" fontFamily={SANS}>{l}</text>
            <line x1="64" x2={76 + FLOW.length * W} y1={y(i)} y2={y(i)} stroke="#23262d" strokeDasharray="2 3" />
          </g>
        ))}
        {FLOW.slice(1).map((s, i) => (
          <line key={i} x1={x(i)} y1={y(FLOW[i].lane)} x2={x(i + 1)} y2={y(s.lane)} stroke={done > i + 1 ? GREEN : "#3a3f48"} strokeWidth="1.5" />
        ))}
        {FLOW.map((s, i) => (
          <g key={i}>
            <circle cx={x(i)} cy={y(s.lane)} r="7" fill="#111318" stroke={done > i ? GREEN : "#5a5f6a"} strokeWidth="1.5" />
            {done > i && <path d={`M${x(i) - 3} ${y(s.lane)} l2 2.2 l4 -4.4`} fill="none" stroke={GREEN} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />}
          </g>
        ))}
      </svg>
    </div>
  );
}

function HeroDemo() {
  const box = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [run, setRun] = useState(0);
  useEffect(() => {
    if (!box.current) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setVisible(true), { threshold: 0.3 });
    io.observe(box.current);
    return () => io.disconnect();
  }, []);
  const shown = useTyping(visible, run);
  const typed = shown >= TOTAL;
  return (
    <div ref={box} className="w-full min-w-0 rounded-lg border border-[#23262d] bg-[#111318] shadow-[0_20px_60px_-20px_#000]">
      <div className="h-9 flex items-center gap-2 px-3 border-b border-[#23262d] text-[12px]" style={{ fontFamily: SANS }}>
        <span className="flex gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-[#3a3f48]" />
          <span className="w-2.5 h-2.5 rounded-full bg-[#3a3f48]" />
          <span className="w-2.5 h-2.5 rounded-full bg-[#3a3f48]" />
        </span>
        <span className="ml-2 text-[#d4d4d4]">payroll.cast</span>
        <span className="flex-1" />
        {typed && !reduceMotion() && (
          <button onClick={() => setRun((r) => r + 1)} className="text-[#8b919c] hover:text-white cursor-pointer" aria-label="Replay the demo">
            Replay
          </button>
        )}
      </div>
      <Editor shown={shown} />
      <Flow go={typed} run={run} />
    </div>
  );
}

const FEATURES = [
  { title: "Write it like a note", body: "Transfers, swaps and contract calls on several chains, in a few readable lines. The editor suggests every command, token and chain as you type." },
  { title: "See it before you sign", body: "Every run starts as a simulation. Balances are checked, gas is estimated and each step is labeled by risk before anything is signed." },
  { title: "Pick up where it stopped", body: "Each step is saved before the next one starts. After a crash, resume from the checkpoint and nothing is sent twice." },
];

const CHAINS = ["NEAR", "Ethereum", "Base", "Arbitrum", "Optimism", "Polygon", "BNB Chain", "Bitcoin", "Solana"];

/** Staggered entrance; the resting state is fully visible. */
const rise = (i: number): React.CSSProperties => ({ animation: `nc-rise 0.7s cubic-bezier(.2,.7,.2,1) ${0.08 * i}s both` });

function PrimaryButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="group h-12 pl-5 pr-4 rounded-lg bg-white text-[#0c0d10] text-[15px] font-medium inline-flex items-center gap-2 cursor-pointer transition hover:bg-[#ecffe6] hover:shadow-[0_0_0_4px_rgba(57,255,20,0.18)]"
    >
      {children}
      <span className="transition-transform group-hover:translate-x-0.5" aria-hidden="true">→</span>
    </button>
  );
}

export function Landing({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="nc-landing h-full overflow-y-auto overflow-x-hidden bg-[#0b0c0f] text-white" style={{ fontFamily: SANS }}>
      <style>{`
        @keyframes nc-rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
        @keyframes nc-breathe { 0%,100% { opacity: .55; } 50% { opacity: .9; } }
        @media (prefers-reduced-motion: reduce) { .nc-landing * { animation: none !important; transition: none !important; } }
      `}</style>

      <header className="sticky top-0 z-20 border-b border-white/[0.06] bg-[#0b0c0f]/70 backdrop-blur-xl">
        <div className="mx-auto max-w-[1180px] h-16 px-[max(16px,4vw)] flex items-center justify-between">
          <a href="#" aria-label="nearcast home" className="inline-flex"><Lockup size={19} /></a>
          <nav className="flex items-center gap-1 sm:gap-2 text-[14px]">
            <a href="#how" className="hidden sm:inline-flex h-9 px-3 items-center rounded-md text-[#a9aeb8] hover:text-white hover:bg-white/[0.05]">How it works</a>
            <button onClick={onOpen} className="h-9 px-3.5 rounded-md bg-white/[0.08] hover:bg-white/[0.14] text-white cursor-pointer">Open Editor</button>
          </nav>
        </div>
      </header>

      <main className="relative">
        {/* Backdrop: a faint grid fading out, and a soft glow behind the demo. */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-[900px]"
          style={{
            backgroundImage: "linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px)",
            backgroundSize: "56px 56px",
            maskImage: "radial-gradient(ellipse 80% 60% at 50% 20%, #000 30%, transparent 75%)",
            WebkitMaskImage: "radial-gradient(ellipse 80% 60% at 50% 20%, #000 30%, transparent 75%)",
          }} />
        <div aria-hidden="true" className="pointer-events-none absolute right-[-10%] top-[60px] w-[min(820px,90vw)] h-[620px] rounded-full"
          style={{ background: "radial-gradient(closest-side, rgba(57,255,20,0.13), transparent)", filter: "blur(10px)", animation: "nc-breathe 6s ease-in-out infinite" }} />

        <section className="relative mx-auto max-w-[1180px] px-[max(16px,4vw)] pt-[clamp(48px,9vw,120px)] pb-[clamp(56px,8vw,112px)] grid gap-[clamp(40px,5vw,72px)] lg:grid-cols-[minmax(0,1fr)_minmax(0,1.08fr)] items-center">
          <div className="flex flex-col gap-[clamp(20px,2.4vw,30px)] min-w-0">
            <div style={rise(0)} className="self-start inline-flex items-center gap-2 h-8 pl-1.5 pr-3 rounded-full border border-white/[0.09] bg-white/[0.03] text-[13px] text-[#c9cdd4]">
              <span className="inline-flex"><Mark size={20} /></span>
              Built on NEAR Chain Signatures
            </div>
            <h1 style={{ ...rise(1), fontSize: "clamp(40px, 5.6vw, 72px)" }} className="m-0 leading-[1.03] font-semibold tracking-[-0.035em] text-balance">
              Script every chain from one{" "}
              <span className="relative whitespace-nowrap">
                NEAR account.
                <span aria-hidden="true" className="absolute left-0 right-[0.4em] -bottom-[0.08em] h-[3px] rounded-full" style={{ background: `linear-gradient(90deg, ${GREEN}, rgba(57,255,20,0))` }} />
              </span>
            </h1>
            <p style={{ ...rise(2), fontSize: "clamp(16px, 1.35vw, 19px)" }} className="m-0 max-w-[540px] leading-[1.6] text-[#a9aeb8]">
              Nearcast turns cross-chain work into a short, readable script. Pay on NEAR, move funds on Base, send Bitcoin or
              swap through NEAR Intents, with a dry run before anything is signed.
            </p>
            <div style={rise(3)} className="flex flex-wrap items-center gap-3">
              <PrimaryButton onClick={onOpen}>Open Editor</PrimaryButton>
              <a href="#how" className="h-12 px-5 rounded-lg border border-white/[0.12] text-[15px] text-white hover:border-white/[0.25] hover:bg-white/[0.03] inline-flex items-center transition">
                How it works
              </a>
            </div>
            <div style={rise(4)} className="text-[13px] text-[#6f7580]">Your wallet signs every step · testnet by default</div>
          </div>
          <div style={rise(2)} className="min-w-0">
            <HeroDemo />
          </div>
        </section>

        <section id="how" className="relative border-t border-white/[0.06]">
          <div className="mx-auto max-w-[1180px] px-[max(16px,4vw)] py-[clamp(56px,8vw,104px)] flex flex-col gap-[clamp(36px,5vw,60px)]">
            <div className="max-w-[660px] flex flex-col gap-4">
              <h2 className="m-0 font-semibold tracking-[-0.025em] text-balance" style={{ fontSize: "clamp(28px, 3.2vw, 40px)" }}>One account, many chains</h2>
              <p className="m-0 text-[clamp(15px,1.25vw,17px)] leading-[1.65] text-[#a9aeb8]">
                Your NEAR account controls an address on every other chain through NEAR Chain Signatures. No extra keys and no
                bridges to babysit: Nearcast plans each step, your wallet approves it, and the run is tracked until it lands.
              </p>
            </div>
            <div className="grid gap-4 md:grid-cols-3">
              {FEATURES.map((f) => (
                <div key={f.title} className="group flex flex-col gap-3 p-6 rounded-xl border border-white/[0.07] bg-white/[0.02] transition hover:border-[rgba(57,255,20,0.35)] hover:bg-white/[0.035]">
                  <span className="inline-flex transition-transform group-hover:-translate-y-0.5"><Mark size={28} /></span>
                  <div className="text-[17px] font-medium">{f.title}</div>
                  <p className="m-0 text-[15px] leading-[1.6] text-[#a9aeb8]">{f.body}</p>
                </div>
              ))}
            </div>
            <div className="flex flex-col gap-3">
              <div className="text-[13px] text-[#6f7580]">Works on</div>
              <div className="flex flex-wrap gap-2">
                {CHAINS.map((c) => (
                  <span key={c} className="h-9 px-3.5 inline-flex items-center rounded-full border border-white/[0.08] text-[14px] text-[#d9dce1]">{c}</span>
                ))}
                <span className="h-9 px-3.5 inline-flex items-center rounded-full border border-[rgba(57,255,20,0.45)] text-[14px]" style={{ color: GREEN }}>+ NEAR Intents swaps</span>
              </div>
            </div>
          </div>
        </section>

        <section className="relative border-t border-white/[0.06]">
          <div className="mx-auto max-w-[1180px] px-[max(16px,4vw)] py-[clamp(48px,7vw,88px)]">
            <div className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-[#101216] px-[clamp(24px,4vw,56px)] py-[clamp(32px,4.5vw,56px)] flex flex-col md:flex-row md:items-center justify-between gap-8">
              <div aria-hidden="true" className="absolute -right-24 -top-24 w-[380px] h-[380px] rounded-full" style={{ background: "radial-gradient(closest-side, rgba(57,255,20,0.14), transparent)" }} />
              <div className="relative flex items-center gap-5">
                <span className="hidden sm:inline-flex"><Mark size={64} /></span>
                <div className="flex flex-col gap-2">
                  <div className="font-semibold tracking-[-0.02em]" style={{ fontSize: "clamp(22px, 2.4vw, 30px)" }}>Try it with the examples</div>
                  <div className="text-[15px] text-[#a9aeb8]">Connect a wallet, simulate, and nothing is signed until you confirm.</div>
                </div>
              </div>
              <div className="relative"><PrimaryButton onClick={onOpen}>Open Editor</PrimaryButton></div>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-white/[0.06]">
        <div className="mx-auto max-w-[1180px] px-[max(16px,4vw)] py-8 flex flex-wrap items-center justify-between gap-4 text-[13px] text-[#6f7580]">
          <Lockup size={15} ink="#c9cdd4" />
          <span>Built on NEAR Chain Signatures and NEAR Intents</span>
        </div>
      </footer>
    </div>
  );
}
