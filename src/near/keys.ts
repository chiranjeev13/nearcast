import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { NearSigner, newKeyPair } from "./tx.js";

/**
 * Local NEAR keys, per network. Sources, in order: NEAR_ACCOUNT_ID + NEAR_PRIVATE_KEY env vars,
 * then ~/.near-credentials/<network>/<account>.json (the near-cli layout). Keys are never printed.
 */
export interface KeyRing {
  has(accountId: string): boolean;
  signer(accountId: string): NearSigner;
  /** Accounts with a key on this network. */
  accounts(): string[];
  /** Key for an account about to be created: reuse the saved one, or make and save a new one. */
  ensureNew(accountId: string): { publicKey: string; file: string; created: boolean };
}

export function credentialsDir(network: string): string {
  return process.env.NEAR_CREDENTIALS_DIR ?? join(homedir(), ".near-credentials", network);
}

export function fileKeyRing(network: string): KeyRing {
  const dir = credentialsDir(network);
  const cache = new Map<string, NearSigner>();
  const envId = process.env.NEAR_ACCOUNT_ID;
  const envKey = process.env.NEAR_PRIVATE_KEY;
  const fileFor = (id: string) => join(dir, `${id}.json`);
  const readSecret = (id: string): string | null => {
    if (envId === id && envKey) return envKey;
    const f = fileFor(id);
    if (!existsSync(f)) return null;
    try {
      const parsed = JSON.parse(readFileSync(f, "utf8"));
      return parsed.private_key ?? parsed.secret_key ?? null;
    } catch {
      return null;
    }
  };
  return {
    has: (id) => readSecret(id) !== null,
    signer(id) {
      let s = cache.get(id);
      if (!s) {
        const secret = readSecret(id);
        if (!secret) throw new Error(`no local key for ${id}: set NEAR_PRIVATE_KEY or create ${fileFor(id)}`);
        s = new NearSigner(id, secret);
        cache.set(id, s);
      }
      return s;
    },
    accounts() {
      const out = new Set<string>();
      if (envId && envKey) out.add(envId);
      if (existsSync(dir)) {
        for (const f of readdirSync(dir)) if (f.endsWith(".json")) out.add(f.slice(0, -5));
      }
      return [...out].filter((id) => readSecret(id) !== null).sort();
    },
    ensureNew(id) {
      const f = fileFor(id);
      if (existsSync(f)) {
        const s = this.signer(id);
        return { publicKey: s.publicKey, file: f, created: false };
      }
      const kp = newKeyPair();
      mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
      writeFileSync(f, JSON.stringify({ account_id: id, public_key: kp.publicKey, private_key: kp.secretKey }), { mode: 0o600 });
      return { publicKey: kp.publicKey, file: f, created: true };
    },
  };
}
