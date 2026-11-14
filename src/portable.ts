import { sha256 as nobleSha256 } from "@noble/hashes/sha256";

/**
 * Small helpers that work the same in Node and in the browser, so the planner and executor can
 * run in either (the hosted web app runs them in the browser).
 */

/** An environment variable in Node; always undefined in the browser. */
export function envVar(name: string): string | undefined {
  const p = (globalThis as any).process;
  return p?.env?.[name];
}

export function sha256(data: Uint8Array | string): Uint8Array {
  return nobleSha256(typeof data === "string" ? new TextEncoder().encode(data) : data);
}

export function sha256Hex(data: Uint8Array | string): string {
  return [...sha256(data)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
