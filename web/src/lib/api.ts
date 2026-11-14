import type { Ctx, InfoResponse, Snapshot } from "@api";

export class ApiError extends Error {
  constructor(message: string, readonly line?: number) {
    super(message);
  }
}

function token(): string {
  const t = document.querySelector('meta[name="nearcast-token"]')?.getAttribute("content") ?? "";
  // Not replaced = served by the Vite dev server; its proxy adds the header instead.
  return t === "__NEARCAST_TOKEN__" ? "" : t;
}

async function call<T>(name: string, body: object = {}): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const t = token();
  if (t) headers["x-nearcast-token"] = t;
  const res = await fetch(`./api/${name}`, { method: "POST", headers, body: JSON.stringify(body) });
  let data: any = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) throw new ApiError(data?.error ?? `HTTP ${res.status}`, data?.line);
  return data as T;
}

export const api = {
  info: () => call<InfoResponse>("info"),
  plan: (ctx: Ctx, source: string, fresh = false) => call<Snapshot>("plan", { ctx, source, fresh }),
  state: (ctx: Ctx, hash: string) => call<Snapshot>("state", { ctx, hash }),
  run: (ctx: Ctx, hash: string, fresh = false) => call<Snapshot>("run", { ctx, hash, fresh }),
  resume: (ctx: Ctx, hash: string, retryFailed = false) => call<Snapshot>("resume", { ctx, hash, retryFailed }),
  kill: (ctx: Ctx, hash: string) => call<{ ok: true }>("kill", { ctx, hash }),
  wallet: (ctx: Ctx, hash: string, id: string, r: { txHash?: string; error?: string }) =>
    call<Snapshot>("wallet", { ctx, hash, id, ...r }),
  handoff: (ctx: Ctx, hash: string, step: string, r: { txHash?: string; notSent?: boolean }) =>
    call<Snapshot>("handoff", { ctx, hash, step, ...r }),
};
