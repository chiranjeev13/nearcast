import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Env } from "./env.js";
import { liveEnv as coreEnv, type LiveOptions } from "./liveCore.js";

export { explorerUrl } from "./liveCore.js";

/** Node: the portable Env plus reading files a script names, relative to the script's folder. */
export function liveEnv(o: Omit<LiveOptions, "readFile"> & { baseDir?: string }): Env {
  return coreEnv({
    ...o,
    readFile: (path) => new Uint8Array(readFileSync(isAbsolute(path) ? path : resolve(o.baseDir ?? process.cwd(), path))),
  });
}
