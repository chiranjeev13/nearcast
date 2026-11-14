import { useEffect, useRef, useState } from "react";

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
  { icon: "codicon-edit", title: "Write it like a note", body: "Transfers, swaps and contract calls on several chains, in a few readable lines. The editor suggests every command, token and chain." },
  { icon: "codicon-eye", title: "See it before you sign", body: "Every run starts as a simulation. Balances are checked, gas is estimated and each step is labeled by risk." },
  { icon: "codicon-debug-continue", title: "Pick up where it stopped", body: "Each step is saved before the next one starts. After a crash, resume and nothing is sent twice." },
];

const CHAINS = ["NEAR", "Ethereum", "Base", "Arbitrum", "Optimism", "Polygon", "BNB Chain", "Bitcoin", "Solana"];

export function Landing({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="h-full overflow-y-auto bg-[#0c0d10] text-white" style={{ fontFamily: SANS }}>
      <div className="mx-auto max-w-[1120px] px-4 sm:px-8">
        <header className="h-16 flex items-center justify-between">
          <div className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
            <span className="w-2 h-2 rounded-full" style={{ background: GREEN, boxShadow: `0 0 10px ${GREEN}` }} />
            nearcast
          </div>
          <nav className="flex items-center gap-6 text-[14px] text-[#a9aeb8]">
            <a href="#how" className="hover:text-white">How it works</a>
            <button onClick={onOpen} className="hover:text-white cursor-pointer">Editor</button>
          </nav>
        </header>

        <section className="grid gap-12 lg:gap-14 lg:grid-cols-[1fr_1.1fr] items-center py-16 lg:py-24">
          <div className="flex flex-col gap-7 min-w-0">
            <h1 className="m-0 text-[42px] sm:text-[56px] leading-[1.04] font-semibold tracking-[-0.03em] text-balance">
              Script every chain from one NEAR account.
            </h1>
            <p className="m-0 max-w-[520px] text-[17px] leading-[1.6] text-[#a9aeb8]">
              Nearcast turns cross-chain work into a short, readable script. Pay on NEAR, move funds on Base, send Bitcoin or
              swap through NEAR Intents, with a dry run before anything is signed.
            </p>
            <div className="flex flex-wrap gap-3">
              <button onClick={onOpen} className="h-11 px-5 rounded-md bg-white text-[#0c0d10] text-[15px] font-medium hover:bg-[#e8e8e8] cursor-pointer">
                Open Editor
              </button>
              <a href="#how" className="h-11 px-5 rounded-md border border-[#2c3038] text-[15px] text-white hover:border-[#4a4f5a] inline-flex items-center">
                How it works
              </a>
            </div>
            <div className="text-[13px] text-[#6f7580]">Runs on your machine · testnet by default</div>
          </div>
          <HeroDemo />
        </section>

        <section id="how" className="py-16 border-t border-[#1c1f25] flex flex-col gap-12">
          <div className="max-w-[640px] flex flex-col gap-3">
            <h2 className="m-0 text-[28px] font-semibold tracking-[-0.02em]">One account, many chains</h2>
            <p className="m-0 text-[16px] leading-[1.65] text-[#a9aeb8]">
              Your NEAR account controls an address on every other chain through NEAR Chain Signatures. No extra keys and no
              bridges to babysit: Nearcast plans each step, asks NEAR to sign, and tracks it until it lands.
            </p>
          </div>
          <div className="grid gap-10 md:grid-cols-3">
            {FEATURES.map((f) => (
              <div key={f.title} className="flex flex-col gap-3">
                <i className={`codicon ${f.icon}`} style={{ fontSize: 20, color: GREEN }} />
                <div className="text-[17px] font-medium">{f.title}</div>
                <p className="m-0 text-[15px] leading-[1.6] text-[#a9aeb8]">{f.body}</p>
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-3">
            <div className="text-[13px] text-[#6f7580]">Works on</div>
            <div className="text-[17px] leading-[1.9] text-white">
              {CHAINS.map((c, i) => (
                <span key={c}>
                  {c}
                  {i < CHAINS.length - 1 && <span className="text-[#3a3f48] mx-2.5">/</span>}
                </span>
              ))}
              <span className="text-[#a9aeb8]"> and swaps through NEAR Intents</span>
            </div>
          </div>
        </section>

        <section className="py-16 border-t border-[#1c1f25] flex flex-col sm:flex-row sm:items-center justify-between gap-6">
          <div className="flex flex-col gap-2">
            <div className="text-[24px] font-semibold tracking-[-0.02em]">Try the editor</div>
            <div className="text-[15px] text-[#a9aeb8]">Examples included. Nothing is signed until you confirm.</div>
          </div>
          <button onClick={onOpen} className="h-11 px-5 rounded-md bg-white text-[#0c0d10] text-[15px] font-medium hover:bg-[#e8e8e8] cursor-pointer self-start sm:self-auto">
            Open Editor
          </button>
        </section>

        <footer className="py-8 border-t border-[#1c1f25] text-[13px] text-[#6f7580] flex flex-wrap justify-between gap-2">
          <span>nearcast</span>
          <span>Built on NEAR Chain Signatures and NEAR Intents</span>
        </footer>
      </div>
    </div>
  );
}
