import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { decodeJson, encodeJson, type Checkpoint } from "../plan/types.js";
import type { Store } from "./store.js";

export * from "./store.js";

/** One file per (network, account, script hash). The same script text always finds the same run. */
export function checkpointPath(root: string, network: string, account: string, scriptHash: string): string {
  return join(root, network, account, `${scriptHash}.json`);
}

export function fileStore(path: string): Store {
  return {
    load() {
      if (!existsSync(path)) return null;
      const cp = decodeJson<Checkpoint>(readFileSync(path, "utf8"));
      if (cp.version !== 1) throw new Error(`${path}: unsupported checkpoint version ${cp.version}`);
      return cp;
    },
    /** Write-then-rename with fsync: a kill mid-write leaves the previous checkpoint intact. */
    save(cp) {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      const fd = openSync(tmp, "w", 0o600);
      try {
        writeSync(fd, encodeJson(cp));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, path);
    },
  };
}

