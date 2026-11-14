import { baseEncode } from "@near-js/utils";
import { near, tgas } from "../format.js";
import { isPublicKey } from "../near/tx.js";
import { sha256 } from "../portable.js";
import { asInt, asString, show, toJson } from "../plan/eval.js";
import { STORAGE_PRICE_PER_BYTE } from "../plan/planner.js";
import type { KeyPermission, NearAction } from "../plan/types.js";
import { TGAS } from "../registry.js";
import { DEFAULT_CALL_GAS } from "./std.js";
import type { Module } from "./types.js";
import { arity, nearAmount, onlyOpts } from "./types.js";

const EMPTY_CODE = "11111111111111111111111111111111";
const DEFAULT_CREATE_DEPOSIT = 10n ** 23n; // 0.1 NEAR

function pubKey(v: unknown, what: string): string {
  const s = asString(v as any, what);
  if (!isPublicKey(s)) throw new Error(`${what} must be a public key like ed25519:7xT…, got ${s}`);
  return s;
}

function readWasm(ctx: { env: { near: { readFile(p: string): Uint8Array } } }, file: string) {
  const code = ctx.env.near.readFile(file);
  if (code.length < 8 || code[0] !== 0 || code[1] !== 0x61 || code[2] !== 0x73 || code[3] !== 0x6d) {
    throw new Error(`${file} is not a WebAssembly file`);
  }
  const hash = baseEncode(sha256(code));
  return { codeBase64: Buffer.from(code).toString("base64"), sha256: hash, size: code.length };
}

const kb = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} bytes`);

export const account: Module = {
  name: "account",
  summary: "NEAR accounts: create, delete, access keys, contract deployment.",
  commands: {
    async create(ctx, cmd) {
      arity(cmd.args, 1, 1, "account:create <account> [--deposit <amount>] [--key <public key | new>]");
      onlyOpts(cmd, ["deposit", "key"], "account:create");
      const id = asString(await ctx.eval(cmd.args[0]), "account");
      const deposit = cmd.opts.deposit ? await nearAmount(ctx, cmd.opts.deposit, "--deposit") : DEFAULT_CREATE_DEPOSIT;
      const keyArg = cmd.opts.key ? asString(await ctx.eval(cmd.opts.key), "--key") : "new";
      if (/^[0-9a-f]{64}$/.test(id) || /^0x[0-9a-f]{40}$/.test(id)) {
        throw new Error(`${id} is an implicit account: create it by sending NEAR to it (transfer ${id} 0.1)`);
      }
      if ((await ctx.env.near.account(id)).exists) throw new Error(`${id} already exists`);
      let publicKey: string;
      let saved = "";
      if (keyArg === "new") {
        const k = ctx.env.near.newKey(id);
        publicKey = k.publicKey;
        saved = k.file;
        ctx.checks.push({ level: "ok", description: `full-access key for ${id} ${k.created ? "generated and saved to" : "already saved in"} ${k.file}` });
      } else {
        publicKey = pubKey(keyArg, "--key");
      }
      const parent = id.slice(id.indexOf(".") + 1);
      const registrar = ctx.env.near.registrar;
      ctx.created.add(id);
      if (parent === ctx.sender) {
        await ctx.near({
          receiver: id,
          actions: [
            { kind: "create-account", decoded: `create account ${id}` },
            { kind: "transfer", deposit, decoded: `fund it with ${near(deposit)}` },
            { kind: "add-key", publicKey, permission: "full", decoded: `add full-access key ${publicKey}` + (saved ? " (saved locally)" : "") },
          ],
          atomic: true,
          description: `create ${id} with ${near(deposit)}`,
        });
        return;
      }
      if (parent === registrar && !id.slice(0, -parent.length - 1).includes(".")) {
        await ctx.near({
          receiver: registrar,
          actions: [{
            kind: "call",
            method: "create_account",
            args: { new_account_id: id, new_public_key: publicKey },
            deposit,
            gas: 100n * TGAS,
            decoded: `create_account: ${id} with key ${publicKey}`,
          }],
          description: `create top-level account ${id} with ${near(deposit)} (through ${registrar})`,
        });
        return;
      }
      throw new Error(`${id} must be a sub-account of the signer (${ctx.sender}) or a top-level ".${registrar}" account`);
    },

    async delete(ctx, cmd) {
      arity(cmd.args, 0, 0, "account:delete --beneficiary <account>");
      onlyOpts(cmd, ["beneficiary"], "account:delete");
      if (!cmd.opts.beneficiary) throw new Error("account:delete needs --beneficiary <account>: who receives the remaining balance");
      const to = asString(await ctx.eval(cmd.opts.beneficiary), "--beneficiary");
      if (to === ctx.sender) throw new Error("the beneficiary must be another account");
      if (!(await ctx.env.near.account(to)).exists && !ctx.created.has(to)) {
        ctx.checks.push({ level: "fail", description: `line ${ctx.line}: beneficiary ${to} does not exist; its balance would be burned` });
      }
      await ctx.near({
        receiver: ctx.sender,
        actions: [{ kind: "delete-account", beneficiary: to, decoded: `delete ${ctx.sender}, send the remaining balance to ${to}` }],
        description: `delete account ${ctx.sender} (balance goes to ${to})`,
        danger: `deletes ${ctx.sender} permanently; tokens it holds in contracts are not moved`,
      });
    },

    async "add-key"(ctx, cmd) {
      arity(cmd.args, 1, 1, "account:add-key <public key> [--contract <account> --methods \"a,b\" --allowance <amount>]");
      onlyOpts(cmd, ["contract", "methods", "allowance"], "account:add-key");
      const publicKey = pubKey(await ctx.eval(cmd.args[0]), "public key");
      let permission: KeyPermission = "full";
      if (cmd.opts.contract) {
        const receiver = asString(await ctx.eval(cmd.opts.contract), "--contract");
        const m = cmd.opts.methods ? await ctx.eval(cmd.opts.methods) : [];
        const methods = Array.isArray(m) ? m.map((x) => asString(x, "method")) : asString(m, "--methods").split(",").map((x) => x.trim()).filter(Boolean);
        const allowance = cmd.opts.allowance ? await nearAmount(ctx, cmd.opts.allowance, "--allowance") : 25n * 10n ** 22n;
        permission = { receiver, methods, allowance };
      } else if (cmd.opts.methods || cmd.opts.allowance) {
        throw new Error("--methods and --allowance need --contract (a function-call key)");
      }
      const what = permission === "full"
        ? "full-access key"
        : `function-call key for ${permission.receiver}${permission.methods.length ? ` (${permission.methods.join(", ")})` : " (any method)"}, allowance ${near(permission.allowance!)}`;
      await ctx.near({
        receiver: ctx.sender,
        actions: [{ kind: "add-key", publicKey, permission, decoded: `add ${what}: ${publicKey}` }],
        description: `add a ${what} to ${ctx.sender}`,
        danger: permission === "full" ? `whoever holds this key fully controls ${ctx.sender}` : undefined,
      });
    },

    async "delete-key"(ctx, cmd) {
      arity(cmd.args, 1, 1, "account:delete-key <public key>");
      onlyOpts(cmd, [], "account:delete-key");
      const publicKey = pubKey(await ctx.eval(cmd.args[0]), "public key");
      if (!ctx.created.has(ctx.sender)) {
        const keys = await ctx.env.near.accessKeys(ctx.sender);
        const k = keys.find((x) => x.publicKey === publicKey);
        if (!k) ctx.checks.push({ level: "fail", description: `line ${ctx.line}: ${ctx.sender} has no key ${publicKey}` });
        else if (k.permission === "full" && keys.filter((x) => x.permission === "full").length === 1) {
          ctx.checks.push({ level: "fail", description: `line ${ctx.line}: ${publicKey} is the only full-access key of ${ctx.sender}; deleting it locks the account` });
        }
      }
      await ctx.near({
        receiver: ctx.sender,
        actions: [{ kind: "delete-key", publicKey, decoded: `delete key ${publicKey}` }],
        description: `delete key ${publicKey.slice(0, 20)}… from ${ctx.sender}`,
      });
    },

    async deploy(ctx, cmd) {
      arity(cmd.args, 1, 1, "account:deploy <file.wasm> [--init <method> --args {…} --deposit <amount> --gas <amount>]");
      onlyOpts(cmd, ["init", "args", "deposit", "gas"], "account:deploy");
      const file = asString(await ctx.eval(cmd.args[0]), "wasm file");
      const w = readWasm(ctx, file);
      const actions: NearAction[] = [{ kind: "deploy", ...w, decoded: `deploy ${file} (${kb(w.size)}, sha256 ${w.sha256})` }];
      let danger: string | undefined;
      if (!ctx.created.has(ctx.sender)) {
        const info = await ctx.env.near.account(ctx.sender);
        if (info.codeHash === w.sha256) ctx.checks.push({ level: "warn", description: `line ${ctx.line}: ${ctx.sender} already runs this exact code` });
        else if (info.codeHash !== EMPTY_CODE) danger = `replaces the contract already deployed on ${ctx.sender} (code hash ${info.codeHash})`;
      }
      if (cmd.opts.init) {
        const method = asString(await ctx.eval(cmd.opts.init), "--init");
        const argsV = cmd.opts.args ? await ctx.eval(cmd.opts.args) : {};
        if (typeof argsV !== "object" || argsV === null || Array.isArray(argsV)) throw new Error(`--args must be a JSON object, got ${show(argsV)}`);
        const args = toJson(argsV);
        const deposit = cmd.opts.deposit ? asInt(await ctx.eval(cmd.opts.deposit), "--deposit") : 0n;
        const gas = cmd.opts.gas ? asInt(await ctx.eval(cmd.opts.gas), "--gas") : DEFAULT_CALL_GAS;
        actions.push({ kind: "call", method, args, deposit, gas, decoded: `${method}(${JSON.stringify(args)})  [${tgas(gas)}]` });
      } else if (cmd.opts.args || cmd.opts.deposit || cmd.opts.gas) {
        throw new Error("--args, --deposit and --gas belong to --init <method>");
      }
      ctx.lock(ctx.sender, BigInt(w.size) * STORAGE_PRICE_PER_BYTE);
      await ctx.near({
        receiver: ctx.sender,
        actions,
        atomic: actions.length > 1,
        description: `deploy ${file} to ${ctx.sender}` + (cmd.opts.init ? " and initialize it" : "") +
          ` (locks about ${near(BigInt(w.size) * STORAGE_PRICE_PER_BYTE)} for storage)`,
        danger,
      });
    },

    async "deploy-global"(ctx, cmd) {
      arity(cmd.args, 1, 1, "account:deploy-global <file.wasm> [--by hash|account]");
      onlyOpts(cmd, ["by"], "account:deploy-global");
      const file = asString(await ctx.eval(cmd.args[0]), "wasm file");
      const by = cmd.opts.by ? asString(await ctx.eval(cmd.opts.by), "--by") : "hash";
      if (by !== "hash" && by !== "account") throw new Error("--by must be hash or account");
      const w = readWasm(ctx, file);
      const cost = BigInt(w.size) * STORAGE_PRICE_PER_BYTE * 10n;
      ctx.lock(ctx.sender, cost);
      await ctx.near({
        receiver: ctx.sender,
        actions: [{
          kind: "deploy-global", ...w, mode: by === "hash" ? "hash" : "account",
          decoded: `publish ${file} as a global contract (${kb(w.size)}), referenced by ${by === "hash" ? `code hash ${w.sha256}` : `account ${ctx.sender}`}`,
        }],
        description: `publish ${file} as a global contract, by ${by}`,
        danger: `burns about ${near(cost)} for global storage; it is not refunded`,
      });
    },

    async "use-global"(ctx, cmd) {
      arity(cmd.args, 1, 1, "account:use-global <code hash | account>");
      onlyOpts(cmd, [], "account:use-global");
      const ref = asString(await ctx.eval(cmd.args[0]), "global contract");
      const isHash = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(ref);
      await ctx.near({
        receiver: ctx.sender,
        actions: [{ kind: "use-global", ref: isHash ? { hash: ref } : { account: ref }, decoded: `use global contract ${isHash ? `with code hash ${ref}` : `published by ${ref}`}` }],
        description: `make ${ctx.sender} run the global contract ${ref}`,
      });
    },
  },
  helpers: {
    async exists(ctx, args) {
      arity(args, 1, 1, "@account:exists(<account>)");
      return (await ctx.env.near.account(asString(args[0], "account"))).exists;
    },
    async balance(ctx, args) {
      arity(args, 0, 1, "@account:balance([account])");
      return ctx.env.near.balance(args[0] === undefined ? ctx.env.near.accountId : asString(args[0], "account"));
    },
    async keys(ctx, args) {
      arity(args, 0, 1, "@account:keys([account])");
      const keys = await ctx.env.near.accessKeys(args[0] === undefined ? ctx.env.near.accountId : asString(args[0], "account"));
      return keys.map((k) => k.publicKey);
    },
    async "code-hash"(ctx, args) {
      arity(args, 0, 1, "@account:code-hash([account])");
      return (await ctx.env.near.account(args[0] === undefined ? ctx.env.near.accountId : asString(args[0], "account"))).codeHash;
    },
  },
  docs: {
    create: {
      usage: "account:create <account> [--deposit <amount>] [--key <public key | new>]",
      summary: "Create a sub-account (x.you.testnet) or a top-level account (x.testnet).",
      details: "Default deposit 0.1 NEAR. --key new (default) generates a key and saves it to ~/.near-credentials, so `as <account> ( ... )` can use it.",
      example: "account:create app.me.testnet --deposit 2",
      opts: [
        { name: "deposit", value: "<amount>", summary: "initial balance in NEAR (default 0.1)" },
        { name: "key", value: "<public key | new>", summary: "full-access key (default: new, saved locally)" },
      ],
      chains: ["near"],
    },
    delete: {
      usage: "account:delete --beneficiary <account>",
      summary: "Delete the signing account and send its balance to the beneficiary.",
      example: "as old.me.testnet (\n  account:delete --beneficiary me.testnet\n)",
      opts: [{ name: "beneficiary", value: "<account>", summary: "receives the remaining NEAR" }],
      chains: ["near"],
    },
    "add-key": {
      usage: 'account:add-key <public key> [--contract <account> --methods "a,b" --allowance <amount>]',
      summary: "Add a full-access key, or a function-call key with --contract.",
      example: 'account:add-key ed25519:7xT… --contract game.testnet --methods "play,claim" --allowance 0.25',
      opts: [
        { name: "contract", value: "<account>", summary: "makes it a function-call key for this contract" },
        { name: "methods", value: '"a,b"', summary: "allowed methods (default: any)" },
        { name: "allowance", value: "<amount>", summary: "NEAR it may spend on gas (default 0.25)" },
      ],
      chains: ["near"],
    },
    "delete-key": { usage: "account:delete-key <public key>", summary: "Remove an access key.", example: "account:delete-key ed25519:7xT…", chains: ["near"] },
    deploy: {
      usage: "account:deploy <file.wasm> [--init <method> --args {…} --deposit <amount> --gas <amount>]",
      summary: "Deploy a contract to the signing account, optionally initializing it atomically.",
      details: "Paths are relative to the script. Storage locks about 1 NEAR per 100 KB.",
      example: 'account:deploy ./counter.wasm --init new --args {"owner": "me.testnet"}',
      opts: [
        { name: "init", value: "<method>", summary: "call this method in the same transaction" },
        { name: "args", value: "{…}", summary: "init arguments" },
        { name: "deposit", value: "<amount>", summary: "init deposit (1yocto, 1near)" },
        { name: "gas", value: "<amount>", summary: "init gas (default 30tgas)" },
      ],
      chains: ["near"],
    },
    "deploy-global": {
      usage: "account:deploy-global <file.wasm> [--by hash|account]",
      summary: "Publish code once as a global contract that other accounts can use.",
      opts: [{ name: "by", value: "hash|account", summary: "how others reference it (default hash)" }],
      chains: ["near"],
    },
    "use-global": {
      usage: "account:use-global <code hash | account>",
      summary: "Make the signing account run a published global contract.",
      chains: ["near"],
    },
    "@exists": { usage: "@account:exists(<account>)", summary: "true if the account exists." },
    "@balance": { usage: "@account:balance([account])", summary: "NEAR balance in yoctoNEAR." },
    "@keys": { usage: "@account:keys([account])", summary: "List of public keys on the account." },
    "@code-hash": { usage: "@account:code-hash([account])", summary: "Contract code hash (all 1s = no contract)." },
  },
};
