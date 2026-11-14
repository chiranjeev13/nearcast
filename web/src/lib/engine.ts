import type { FileEntry } from "@api";
import { decodeJson, encodeJson, type Checkpoint } from "../../../src/plan/types.ts";
import type { Store } from "../../../src/exec/store.ts";
import type { KeyRing } from "../../../src/near/keys.ts";
import { liveEnv } from "../../../src/liveCore.ts";
import { createApi, type FilesBackend } from "../../../src/ui/core.ts";

/**
 * The whole engine (planner, executor, checkpoints) running in the browser. No keys: every NEAR
 * step is signed by the connected wallet, deposits with --from-wallet by MetaMask. Checkpoints and
 * scripts live in this browser's storage, so a run survives a closed tab and can be resumed.
 */

const PREFIX = "nearcast:";

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}
function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(PREFIX + key, value);
  } catch (e) {
    throw new Error(`browser storage is full or blocked: ${(e as Error).message}`);
  }
}
function lsDel(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* nothing to do */
  }
}

/** One run's checkpoint, written before every side effect (same contract as the CLI's files). */
function checkpointStore(key: string): Store {
  return {
    load() {
      const raw = lsGet(key);
      return raw ? decodeJson<Checkpoint>(raw) : null;
    },
    save(cp) {
      lsSet(key, encodeJson(cp));
    },
  };
}

/** No local keys in the browser: everything is signed by a wallet. */
const NO_KEYS: KeyRing = {
  has: () => false,
  signer: (id) => {
    throw new Error(`no local key for ${id}: the web app signs with your wallet`);
  },
  accounts: () => [],
  ensureNew: () => {
    throw new Error("in the web app, give the new account's key: account:create <name> --key <your public key>");
  },
};

// Scripts: { name: { source, mtime } } in one storage entry.
type FileMap = Record<string, { source: string; mtime: string }>;
const loadFiles = (): FileMap => {
  try {
    return JSON.parse(lsGet("files") ?? "{}") as FileMap;
  } catch {
    return {};
  }
};
const saveFiles = (m: FileMap) => lsSet("files", JSON.stringify(m));
const entryOf = (name: string, f: { source: string; mtime: string }): FileEntry => ({ name, size: f.source.length, mtime: f.mtime });

const files: FilesBackend = {
  dir: "browser",
  list: () => Object.entries(loadFiles()).map(([n, f]) => entryOf(n, f)).sort((a, b) => a.name.localeCompare(b.name)),
  read(name) {
    const f = loadFiles()[name];
    if (!f) throw new Error(`${name} does not exist`);
    return f.source;
  },
  write(name, source, create) {
    const m = loadFiles();
    if (create && m[name]) throw new Error(`${name} already exists`);
    m[name] = { source, mtime: new Date().toISOString() };
    saveFiles(m);
    return entryOf(name, m[name]);
  },
  rename(from, to) {
    const m = loadFiles();
    if (!m[from]) throw new Error(`${from} does not exist`);
    if (m[to]) throw new Error(`${to} already exists`);
    m[to] = { ...m[from], mtime: new Date().toISOString() };
    delete m[from];
    saveFiles(m);
    return entryOf(to, m[to]);
  },
  remove(name) {
    const m = loadFiles();
    if (!m[name]) throw new Error(`${name} does not exist`);
    delete m[name];
    saveFiles(m);
  },
};

// Examples are bundled at build time from the repo's examples/ folder.
const EXAMPLES = Object.entries(import.meta.glob("../../../examples/*.cast", { query: "?raw", import: "default", eager: true }) as Record<string, string>)
  .map(([path, source]) => ({ name: path.split("/").pop()!, source }))
  .sort((a, b) => a.name.localeCompare(b.name));

export const engine = createApi({
  makeEnv: (network, account, _signer, evmAccount) => ({ ...liveEnv({ network, accountId: account, keys: NO_KEYS }), evmWallet: evmAccount }),
  keyAccounts: () => [],
  defaultNetwork: "testnet",
  examples: () => EXAMPLES,
  checkpoints(network, account, hash) {
    const key = `cp:${network}:${account}:${hash}`;
    return {
      store: checkpointStore(key),
      archive() {
        const raw = lsGet(key);
        if (raw) lsSet(`${key}:done:${Date.now()}`, raw);
        lsDel(key);
      },
    };
  },
  files,
});
