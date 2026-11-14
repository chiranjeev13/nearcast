import { NEAR } from "./registry.js";

/** Exact decimal rendering of `raw / 10^decimals`, trimmed. */
export function units(raw: bigint, decimals: number): string {
  const neg = raw < 0n;
  const s = (neg ? -raw : raw).toString().padStart(decimals + 1, "0");
  const int = s.slice(0, s.length - decimals);
  const frac = decimals ? s.slice(-decimals).replace(/0+$/, "") : "";
  return (neg ? "-" : "") + int + (frac ? "." + frac : "");
}

export function near(yocto: bigint): string {
  if (yocto === 0n) return "0 NEAR";
  if (yocto < 10n ** 6n) return `${yocto} yoctoNEAR`;
  return `${trim(units(yocto, 24), 6)} NEAR`;
}

export const eth = (wei: bigint): string => `${trim(units(wei, 18), 9)} ETH`;
export const tgas = (gas: bigint): string => `${units(gas, 12)} Tgas`;

/** Keep at most `places` fractional digits, but never round a non-zero amount down to "0". */
function trim(s: string, places: number): string {
  const [i, f = ""] = s.split(".");
  if (f.length <= places) return s;
  const cut = f.slice(0, places).replace(/0+$/, "");
  if (cut === "" && i === "0") return `<0.${"0".repeat(places - 1)}1`;
  return cut ? `${i}.${cut}` : i;
}

void NEAR;
