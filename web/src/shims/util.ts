/** Minimal util.format (%s %d %j %%) for libraries that generate code strings in the browser. */
export function format(f: unknown, ...args: unknown[]): string {
  if (typeof f !== "string") return [f, ...args].map(String).join(" ");
  let i = 0;
  const out = f.replace(/%[sdij%]/g, (m) => {
    if (m === "%%") return "%";
    if (i >= args.length) return m;
    const a = args[i++];
    if (m === "%d" || m === "%i") return String(Number(a));
    if (m === "%j") return JSON.stringify(a);
    return String(a);
  });
  return [out, ...args.slice(i).map(String)].join(" ");
}
export default { format };
