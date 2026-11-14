import { account } from "./account.js";
import { chainsig } from "./chainsig.js";
import { intents } from "./intents.js";
import { meta } from "./meta.js";
import { nft } from "./nft.js";
import { stake } from "./stake.js";
import { std } from "./std.js";
import { token } from "./token.js";
import type { Module } from "./types.js";

/** Module registry. To add a module: write a Module object (with docs) and list it here. `std` is always loaded. */
export const MODULES: Record<string, Module> = { std, token, nft, account, stake, meta, chainsig, intents };
