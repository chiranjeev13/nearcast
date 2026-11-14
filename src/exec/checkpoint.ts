import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { decodeJson, encodeJson, type Checkpoint, type Plan } from "../plan/types.js";

export interface Store {
  load(): Checkpoint | null;
  save(cp: Checkpoint): void;
}

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

export function memoryStore(initial: Checkpoint | null = null): Store & { saves: number } {
  let text = initial ? encodeJson(initial) : null;
  return {
    saves: 0,
    load: () => (text === null ? null : decodeJson<Checkpoint>(text)),
    save(cp) {
      text = encodeJson(cp);
      this.saves++;
    },
  };
}

export function newCheckpoint(plan: Plan): Checkpoint {
  return {
    version: 1,
    plan,
    state: Object.fromEntries(plan.steps.map((s) => [s.id, { status: "planned" as const }])),
    log: [],
  };
}

export const isComplete = (cp: Checkpoint): boolean => cp.plan.steps.every((s) => cp.state[s.id]?.status === "confirmed");
/** Steps whose signed transaction may be in flight. A fresh plan while any exist could double-send. */
export const inFlight = (cp: Checkpoint): string[] =>
  cp.plan.steps.filter((s) => ["signed", "broadcast"].includes(cp.state[s.id]?.status)).map((s) => s.id);
