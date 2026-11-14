import { useEffect, useState } from "react";

const COLORS = ["#39ff14", "#c49bff", "#7fa8ff", "#e8c46a", "#ff9e64", "#e4e8f1"];

/** A short burst of neon squares from a point. Fires each time `fire` changes to a new truthy value. */
export function Confetti({ fire }: { fire: string | null }) {
  const [bits, setBits] = useState<{ id: string; style: React.CSSProperties }[]>([]);
  useEffect(() => {
    if (!fire || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const ox = innerWidth / 2;
    const oy = innerHeight * 0.62;
    setBits(
      Array.from({ length: 48 }, (_, i) => {
        const a = (Math.PI * 2 * i) / 48 + Math.random() * 0.4;
        const d = 140 + Math.random() * 260;
        return {
          id: `${fire}-${i}`,
          style: {
            left: ox,
            top: oy,
            background: COLORS[i % COLORS.length],
            borderRadius: i % 3 === 0 ? "50%" : "1px",
            animationDelay: `${Math.random() * 120}ms`,
            ["--dx" as string]: `${Math.cos(a) * d}px`,
            ["--dy" as string]: `${Math.sin(a) * d + 220}px`,
            ["--rot" as string]: `${Math.random() * 720 - 360}deg`,
          },
        };
      }),
    );
    const t = setTimeout(() => setBits([]), 1900);
    return () => clearTimeout(t);
  }, [fire]);
  return <>{bits.map((b) => <span key={b.id} className="confetti" style={b.style} />)}</>;
}
