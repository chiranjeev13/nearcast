import { ScriptError } from "../lang/ast.js";
import { asInt, asString, show, toJson } from "../plan/eval.js";
import { EVM_TOKENS, NEAR_TOKENS, TGAS } from "../registry.js";
import { near, tgas } from "../format.js";
import type { Module } from "./types.js";
import { arity, nearAmount, onlyOpts } from "./types.js";

export const DEFAULT_CALL_GAS = 30n * TGAS;

export const std: Module = {
  name: "std",
  summary: "Built-ins: contract calls, NEAR transfers, atomic batches, signing as another account.",
  commands: {
    async call(ctx, cmd) {
      arity(cmd.args, 2, 3, "call <contract> <method> [{json args}] [--deposit <amount>] [--gas <amount>]");
      onlyOpts(cmd, ["deposit", "gas"], "call");
      const receiver = asString(await ctx.eval(cmd.args[0]), "contract");
      const method = asString(await ctx.eval(cmd.args[1]), "method");
      const argsV = cmd.args[2] ? await ctx.eval(cmd.args[2]) : {};
      if (typeof argsV !== "object" || argsV === null || Array.isArray(argsV) || "$decimal" in argsV) {
        throw new Error(`call arguments must be a JSON object like {"key": value}, got ${show(argsV)}`);
      }
      const deposit = cmd.opts.deposit ? asInt(await ctx.eval(cmd.opts.deposit), "--deposit") : 0n;
      const gas = cmd.opts.gas ? asInt(await ctx.eval(cmd.opts.gas), "--gas") : DEFAULT_CALL_GAS;
      const args = toJson(argsV);
      const decoded = `${method}(${JSON.stringify(args)})`;
      await ctx.near({
        receiver,
        actions: [{ kind: "call", method, args, deposit, gas, decoded }],
        description: `call ${receiver}.${decoded}` + (deposit ? ` with ${near(deposit)} attached` : "") +
          (gas !== DEFAULT_CALL_GAS ? ` (${tgas(gas)})` : ""),
      });
    },

    async transfer(ctx, cmd) {
      if (cmd.args.length === 3) throw new Error("transfer sends NEAR: transfer <receiver> <amount>; for tokens use token:transfer <token> <recipient> <amount>");
      arity(cmd.args, 2, 2, "transfer <receiver> <amount>");
      onlyOpts(cmd, [], "transfer");
      const to = asString(await ctx.eval(cmd.args[0]), "receiver");
      const amount = await nearAmount(ctx, cmd.args[1], "amount");
      if (amount <= 0n) throw new Error("amount must be greater than zero");
      const implicit = /^[0-9a-f]{64}$/.test(to) || /^0x[0-9a-f]{40}$/.test(to);
      const exists = (await ctx.env.near.account(to)).exists || ctx.created.has(to);
      if (!exists && !implicit) {
        ctx.checks.push({ level: "fail", description: `line ${ctx.line}: ${to} does not exist; a transfer to it would fail and refund minus fees` });
      }
      await ctx.near({
        receiver: to,
        actions: [{ kind: "transfer", deposit: amount, decoded: `transfer ${near(amount)} (${amount} yoctoNEAR)` }],
        description: `send ${near(amount)} to ${to}` + (!exists && implicit ? " (creates this implicit account)" : ""),
      });
    },

    async batch(ctx, cmd) {
      if (cmd.args.length > 1 || !cmd.block) throw new Error("usage: batch [<receiver>] ( ... )");
      await ctx.batch(cmd, cmd.args[0] ? asString(await ctx.eval(cmd.args[0]), "batch receiver") : undefined);
    },

    async seq(ctx, cmd) {
      if (cmd.args.length !== 0 || !cmd.block) throw new Error("usage: seq ( ... )");
      if (ctx.scopeKind !== "seq") {
        throw new ScriptError(
          ctx.scopeKind === "batch" || ctx.scopeKind === "meta"
            ? "seq cannot be used inside a batch or meta transaction: those are one atomic transaction, a seq is several"
            : "seq cannot be used inside chainsig:on",
          cmd.loc,
        );
      }
      await ctx.block(cmd.block, { kind: "seq" });
    },

    async as(ctx, cmd) {
      if (cmd.args.length !== 1 || !cmd.block) throw new Error("usage: as <account> ( ... )");
      await ctx.as(cmd, asString(await ctx.eval(cmd.args[0]), "account"));
    },
  },
  helpers: {
    async me(ctx, args) {
      arity(args, 0, 0, "@me");
      return ctx.env.near.accountId;
    },

    async view(ctx, args) {
      arity(args, 2, 3, "@view(<contract> <method> [{json args}])");
      const r = await ctx.env.near.view(asString(args[0], "contract"), asString(args[1], "method"), toJson(args[2] ?? {}));
      return fromJson(r);
    },

    async token(ctx, args) {
      arity(args, 1, 1, "@token(<symbol>)");
      const sym = asString(args[0], "token symbol");
      if (ctx.evm) {
        const a = EVM_TOKENS[ctx.evm.chain.chainId]?.[sym];
        if (!a) throw new Error(`no ${sym} address known on ${ctx.evm.chain.label}; pass the contract address instead`);
        return a;
      }
      const a = (NEAR_TOKENS as Record<string, Record<string, string>>)[ctx.env.near.network]?.[sym];
      if (!a) throw new Error(`no ${sym} contract known on NEAR ${ctx.env.near.network}; pass the contract account instead`);
      return a;
    },

    async balance(ctx, args) {
      arity(args, 0, 1, "@balance([account])");
      return ctx.env.near.balance(args[0] === undefined ? ctx.env.near.accountId : asString(args[0], "account"));
    },

    async exists(ctx, args) {
      arity(args, 1, 1, "@exists(<account>)");
      return (await ctx.env.near.account(asString(args[0], "account"))).exists;
    },
  },
  docs: {
    call: {
      usage: "call <contract> <method> [{json args}] [--deposit <amount>] [--gas <amount>]",
      summary: "Call a NEAR contract method.",
      details: "Deposit and gas are base units: use 1yocto, 0.1near, 50tgas. Default gas 30 Tgas.",
      example: 'call counter.testnet increment {"by": 2} --gas 50tgas',
      opts: [
        { name: "deposit", value: "<amount>", summary: "NEAR attached (1yocto, 0.5near)" },
        { name: "gas", value: "<amount>", summary: "gas attached (default 30tgas)" },
      ],
      chains: ["near"],
    },
    transfer: {
      usage: "transfer <receiver> <amount>",
      summary: "Send NEAR. Amount in NEAR (1, 0.25) or with a unit (1near, 500yocto).",
      details: "Sending to a 64-hex or 0x implicit account creates it.",
      example: "transfer bob.testnet 0.5",
      chains: ["near"],
    },
    batch: {
      usage: "batch [<receiver>] ( ... )",
      summary: "One atomic transaction: every action inside goes to one receiver; all succeed or none do.",
      details: "Without <receiver>, the first action decides it. Several intents:swap deposits from the same NEAR token fit in one batch: one approval.",
      example: "batch counter.testnet (\n  call counter.testnet increment\n  call counter.testnet increment\n)",
      block: true,
      chains: ["near"],
    },
    seq: {
      usage: "seq ( ... )",
      summary: "Steps in order, explicitly not atomic.",
      block: true,
    },
    as: {
      usage: "as <account> ( ... )",
      summary: "Sign the block's NEAR transactions as another account you hold a local key for.",
      details: "Keys come from ~/.near-credentials/<network>/<account>.json, e.g. one saved by account:create.",
      example: "as app.me.testnet (\n  account:deploy ./app.wasm\n)",
      block: true,
      chains: ["near"],
    },
    "@me": { usage: "@me", summary: "The account running the script." },
    "@view": {
      usage: "@view(<contract> <method> [{json args}])",
      summary: "Read-only contract call.",
      example: '@view(counter.testnet get_num {})',
      chains: ["near"],
    },
    "@token": {
      usage: "@token(<symbol>)",
      summary: "Token contract for a symbol: NEP-141 on NEAR, ERC-20 inside chainsig:on.",
      example: "@token(USDC)",
    },
    "@balance": { usage: "@balance([account])", summary: "NEAR balance in yoctoNEAR (default: @me).", example: "assert @balance > 1near" },
    "@exists": { usage: "@exists(<account>)", summary: "true if the NEAR account exists.", example: "assert @exists(bob.testnet) == true" },
  },
};

/** View results arrive as plain JSON. Integers become bigints so they compare exactly. */
export function fromJson(x: any): any {
  if (typeof x === "number") {
    if (Number.isInteger(x)) return BigInt(x);
    const s = String(x);
    const f = s.split(".")[1] ?? "";
    if (/^\d+\.\d+$/.test(s)) return { $decimal: { digits: BigInt(s.replace(".", "")), exp: -f.length } };
    return s;
  }
  if (Array.isArray(x)) return x.map(fromJson);
  if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, fromJson(v)]));
  return x;
}
