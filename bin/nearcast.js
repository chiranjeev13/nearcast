#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Run the compiled CLI when it exists (npm run build), otherwise run the TypeScript source through tsx.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const built = join(root, "dist", "cli.js");
const cmd = existsSync(built)
  ? [process.execPath, [built]]
  : [process.execPath, ["--import", "tsx", join(root, "src", "cli.ts")]];
const r = spawnSync(cmd[0], [...cmd[1], ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
