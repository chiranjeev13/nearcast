import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkpointPath, fileStore } from "../exec/checkpoint.js";
import { ScriptError } from "../lang/ast.js";
import type { FileEntry } from "./api.js";
import { createApi, type CoreOptions } from "./core.js";

export { toWalletActions } from "./core.js";

export interface UiOptions extends Omit<CoreOptions, "examples" | "checkpoints" | "files"> {
  stateDir: string;
  port: number;
  examplesDir: string;
  /** Folder of the user's own .cast files, shown in the explorer. Created on first write. */
  workspaceDir: string;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".json": "application/json", ".wasm": "application/wasm",
};

/**
 * Local web UI. It drives the same planner, executor and checkpoint files as the CLI.
 * It can hold signing keys, so it listens on 127.0.0.1 only and every API call must carry a
 * per-process token that only the served page knows.
 */
export function startUi(o: UiOptions): Promise<string> {
  const token = process.env.NEARCAST_UI_TOKEN ?? randomBytes(24).toString("hex");
  const here = dirname(fileURLToPath(import.meta.url));
  const webDist = resolve(here, "..", "..", "web", "dist");
  const wsDir = resolve(o.workspaceDir);
  const pathOf = (name: string) => {
    const p = resolve(wsDir, name);
    if (dirname(p) !== wsDir) throw new Error("outside the workspace");
    return p;
  };
  const entry = (p: string): FileEntry => {
    const st = statSync(p);
    return { name: p.slice(wsDir.length + 1), size: st.size, mtime: st.mtime.toISOString() };
  };

  const api = createApi({
    ...o,
    examples: () =>
      existsSync(o.examplesDir)
        ? readdirSync(o.examplesDir).filter((f) => f.endsWith(".cast")).sort().map((f) => ({ name: f, source: readFileSync(join(o.examplesDir, f), "utf8") }))
        : [],
    checkpoints(network, account, hash) {
      const path = checkpointPath(resolve(o.stateDir), network, account, hash);
      return { store: fileStore(path), archive: () => renameSync(path, path.replace(/\.json$/, `.${Date.now()}.done.json`)) };
    },
    files: {
      dir: wsDir,
      list: () =>
        existsSync(wsDir)
          ? readdirSync(wsDir).filter((f) => f.endsWith(".cast")).sort((a, b) => a.localeCompare(b)).map((f) => entry(join(wsDir, f)))
          : [],
      read(name) {
        const p = pathOf(name);
        if (!existsSync(p)) throw new Error(`${name} does not exist`);
        return readFileSync(p, "utf8");
      },
      write(name, source, create) {
        const p = pathOf(name);
        if (create && existsSync(p)) throw new Error(`${name} already exists`);
        mkdirSync(wsDir, { recursive: true });
        writeFileSync(p, source);
        return entry(p);
      },
      rename(from, to) {
        const a = pathOf(from);
        const b = pathOf(to);
        if (!existsSync(a)) throw new Error(`${from} does not exist`);
        if (existsSync(b)) throw new Error(`${to} already exists`);
        renameSync(a, b);
        return entry(b);
      },
      remove(name) {
        const p = pathOf(name);
        if (!existsSync(p)) throw new Error(`${name} does not exist`);
        unlinkSync(p);
      },
    },
  });

  const page = (): string => {
    const f = join(webDist, "index.html");
    if (!existsSync(f)) return "<!doctype html><title>nearcast</title><pre>Web UI not built. Run: npm run build:web</pre>";
    return readFileSync(f, "utf8").replace(/__NEARCAST_TOKEN__/g, token);
  };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const send = (code: number, body: unknown, type = "application/json") => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    try {
      // Reject anything not addressed to localhost (DNS rebinding) and anything without the token (cross-site requests).
      const host = (req.headers.host ?? "").replace(/:\d+$/, "");
      if (host !== "127.0.0.1" && host !== "localhost") return send(403, { error: "forbidden" });
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) return send(200, page(), MIME[".html"]);
      if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
        const f = normalize(join(webDist, url.pathname));
        if (!f.startsWith(webDist + "/") || !existsSync(f)) return send(404, { error: "not found" });
        res.writeHead(200, { "content-type": MIME[extname(f)] ?? "application/octet-stream", "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" });
        return res.end(readFileSync(f));
      }
      const name = /^\/api\/([a-z]+)$/.exec(url.pathname)?.[1];
      if (req.method !== "POST" || !name || !api[name]) return send(404, { error: "not found" });
      if (req.headers["x-nearcast-token"] !== token) return send(403, { error: "forbidden" });
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 8_000_000) return send(413, { error: "too large" });
      }
      send(200, await api[name](raw ? JSON.parse(raw) : {}));
    } catch (e) {
      const line = e instanceof ScriptError ? e.loc?.line : undefined;
      send(400, { error: (e as Error).message, line });
    }
  });

  return new Promise((ok, fail) => {
    server.on("error", fail);
    server.listen(o.port, "127.0.0.1", () => ok(`http://127.0.0.1:${o.port}/`));
  });
}
