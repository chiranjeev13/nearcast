import type { Ctx, FileEntry, InfoResponse, Snapshot } from "@api";

export class ApiError extends Error {
  constructor(message: string, readonly line?: number) {
    super(message);
  }
}

/**
 * The app's API. The engine runs in this browser and every step is signed by a wallet, both when
 * hosted (Vercel) and when served by `nearcast ui`. No keys ever reach a server.
 */
let enginePromise: Promise<Record<string, (body: any) => Promise<unknown>>> | null = null;
const engine = () => (enginePromise ??= import("./engine.ts").then((m) => m.engine));

async function call<T>(name: string, body: object = {}): Promise<T> {
  try {
    return (await (await engine())[name](body)) as T;
  } catch (e: any) {
    throw new ApiError(e?.message ?? String(e), e?.loc?.line);
  }
}

export const api = {
  info: () => call<InfoResponse>("info"),
  files: () => call<{ dir: string; files: FileEntry[] }>("files"),
  read: (name: string) => call<{ name: string; source: string }>("read", { name }),
  write: (name: string, source: string, create = false) => call<FileEntry>("write", { name, source, create }),
  rename: (from: string, to: string) => call<FileEntry>("rename", { from, to }),
  remove: (name: string) => call<{ ok: true }>("delete", { name }),
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
