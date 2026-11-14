import { decodeJson, encodeJson, type Checkpoint, type Plan } from "../plan/types.js";

/** Where a run's checkpoint lives. Node writes files; the web app writes browser storage. */
export interface Store {
  load(): Checkpoint | null;
  save(cp: Checkpoint): void;
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
