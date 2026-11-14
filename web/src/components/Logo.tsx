/**
 * The nearcast mark: the "n" of nearcast drawn as a route, starting on one chain (white node)
 * and landing on another (green node). `small` uses the heavier drawing made for favicon sizes.
 */
export function Mark({ size = 32, ink = "#ffffff", accent = "#39ff14", small = false, title }: {
  size?: number;
  ink?: string;
  accent?: string;
  small?: boolean;
  title?: string;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <path
        d="M18 48 V30 a14 14 0 0 1 28 0 V48"
        fill="none"
        stroke={ink}
        strokeWidth={small ? 8 : 6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {!small && <circle cx="18" cy="48" r="6.5" fill={ink} />}
      <circle cx="46" cy="48" r={small ? 8 : 6.5} fill={accent} />
    </svg>
  );
}

/** Mark + lowercase wordmark, sized by the wordmark's font size. */
export function Lockup({ size = 18, ink = "#ffffff", accent = "#39ff14" }: { size?: number; ink?: string; accent?: string }) {
  return (
    <span className="inline-flex items-center font-semibold" style={{ gap: size * 0.32, fontSize: size, letterSpacing: "-0.035em", color: ink, lineHeight: 1 }}>
      <Mark size={size * 1.35} ink={ink} accent={accent} />
      nearcast
    </span>
  );
}
