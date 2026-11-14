import { ripemd160 } from "@noble/hashes/ripemd160";
import { sha256, sha512 } from "@noble/hashes/sha2";
import { Buffer } from "buffer";

/**
 * Browser stand-in for the bits of node:crypto that wallet libraries and chainsig.js reach for:
 * randomBytes, and createHash for sha256 / sha512 / ripemd160 (pure-JS implementations).
 */
export function randomBytes(n: number): Buffer {
  return Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(n)));
}

const ALGOS = { sha256, sha512, ripemd160 } as const;

export function createHash(algorithm: string) {
  const fn = ALGOS[algorithm.toLowerCase() as keyof typeof ALGOS];
  if (!fn) throw new Error(`createHash: ${algorithm} is not available in the browser`);
  const h = fn.create();
  const api = {
    update(data: string | Uint8Array, enc?: BufferEncoding) {
      h.update(typeof data === "string" ? Buffer.from(data, enc ?? "utf8") : data);
      return api;
    },
    digest(enc?: BufferEncoding) {
      const out = Buffer.from(h.digest());
      return enc ? out.toString(enc) : out;
    },
  };
  return api;
}

export default { randomBytes, createHash };
