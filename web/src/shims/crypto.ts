import { Buffer } from "buffer";

/** Browser stand-in for the bits of node:crypto that wallet libraries reach for. */
export function randomBytes(n: number): Buffer {
  return Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(n)));
}
export default { randomBytes };
