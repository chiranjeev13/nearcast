import { near } from "../format.js";
import { isPublicKey } from "../near/tx.js";
import { asInt, asString } from "../plan/eval.js";
import { TGAS } from "../registry.js";
import type { Module } from "./types.js";
import { arity, nearAmount, onlyOpts } from "./types.js";

const POOL_GAS = 125n * TGAS;

async function amountOrAll(ctx: Parameters<Module["commands"][string]>[0], e: Parameters<typeof nearAmount>[1] | undefined) {
  if (!e) return "all" as const;
  if (e.kind === "word" && e.value === "all") return "all" as const;
  return nearAmount(ctx, e, "amount");
}

export const stake: Module = {
  name: "stake",
  summary: "Staking: delegate to staking pools, or stake natively as a validator.",
  commands: {
    async deposit(ctx, cmd) {
      arity(cmd.args, 2, 2, "stake:deposit <pool> <amount>");
      onlyOpts(cmd, [], "stake:deposit");
      const pool = asString(await ctx.eval(cmd.args[0]), "pool");
      const amount = await nearAmount(ctx, cmd.args[1], "amount");
      if (!(await ctx.env.near.account(pool)).exists) throw new Error(`staking pool ${pool} does not exist`);
      await ctx.near({
        receiver: pool,
        actions: [{ kind: "call", method: "deposit_and_stake", args: {}, deposit: amount, gas: POOL_GAS, decoded: `deposit_and_stake ${near(amount)}` }],
        description: `stake ${near(amount)} with ${pool}`,
      });
    },

    async unstake(ctx, cmd) {
      arity(cmd.args, 1, 2, "stake:unstake <pool> [<amount> | all]");
      onlyOpts(cmd, [], "stake:unstake");
      const pool = asString(await ctx.eval(cmd.args[0]), "pool");
      const amount = await amountOrAll(ctx, cmd.args[1]);
      await ctx.near({
        receiver: pool,
        actions: [amount === "all"
          ? { kind: "call", method: "unstake_all", args: {}, deposit: 0n, gas: POOL_GAS, decoded: "unstake_all" }
          : { kind: "call", method: "unstake", args: { amount: amount.toString() }, deposit: 0n, gas: POOL_GAS, decoded: `unstake ${near(amount)}` }],
        description: `unstake ${amount === "all" ? "everything" : near(amount)} from ${pool} (withdrawable after about 4 epochs)`,
      });
    },

    async withdraw(ctx, cmd) {
      arity(cmd.args, 1, 2, "stake:withdraw <pool> [<amount> | all]");
      onlyOpts(cmd, [], "stake:withdraw");
      const pool = asString(await ctx.eval(cmd.args[0]), "pool");
      const amount = await amountOrAll(ctx, cmd.args[1]);
      await ctx.near({
        receiver: pool,
        actions: [amount === "all"
          ? { kind: "call", method: "withdraw_all", args: {}, deposit: 0n, gas: POOL_GAS, decoded: "withdraw_all" }
          : { kind: "call", method: "withdraw", args: { amount: amount.toString() }, deposit: 0n, gas: POOL_GAS, decoded: `withdraw ${near(amount)}` }],
        description: `withdraw ${amount === "all" ? "all unstaked NEAR" : near(amount)} from ${pool}`,
      });
    },

    async native(ctx, cmd) {
      arity(cmd.args, 2, 2, "stake:native <amount> <validator public key>");
      onlyOpts(cmd, [], "stake:native");
      const amount = await nearAmount(ctx, cmd.args[0], "amount");
      const publicKey = asString(await ctx.eval(cmd.args[1]), "validator key");
      if (!isPublicKey(publicKey)) throw new Error(`validator key must be a public key, got ${publicKey}`);
      ctx.lock(ctx.sender, amount);
      await ctx.near({
        receiver: ctx.sender,
        actions: [{ kind: "stake", amount, publicKey, decoded: amount === 0n ? `stop staking (key ${publicKey})` : `stake ${near(amount)} with validator key ${publicKey}` }],
        description: amount === 0n ? `stop validating as ${ctx.sender}` : `stake ${near(amount)} natively as validator ${ctx.sender}`,
        danger: "native staking makes this account a validator candidate; below the seat price the stake is returned at the epoch end",
      });
    },
  },
  helpers: {
    async staked(ctx, args) {
      arity(args, 1, 2, "@stake:staked(<pool> [account])");
      const who = args[1] === undefined ? ctx.env.near.accountId : asString(args[1], "account");
      return asInt(await ctx.env.near.view(asString(args[0], "pool"), "get_account_staked_balance", { account_id: who }), "staked");
    },
    async unstaked(ctx, args) {
      arity(args, 1, 2, "@stake:unstaked(<pool> [account])");
      const who = args[1] === undefined ? ctx.env.near.accountId : asString(args[1], "account");
      return asInt(await ctx.env.near.view(asString(args[0], "pool"), "get_account_unstaked_balance", { account_id: who }), "unstaked");
    },
    async withdrawable(ctx, args) {
      arity(args, 1, 2, "@stake:withdrawable(<pool> [account])");
      const who = args[1] === undefined ? ctx.env.near.accountId : asString(args[1], "account");
      return Boolean(await ctx.env.near.view(asString(args[0], "pool"), "is_account_unstaked_balance_available", { account_id: who }));
    },
  },
  docs: {
    deposit: {
      usage: "stake:deposit <pool> <amount>",
      summary: "Deposit and stake NEAR with a staking pool.",
      example: "stake:deposit legends.pool.f863973.m0 1",
      chains: ["near"],
    },
    unstake: { usage: "stake:unstake <pool> [<amount> | all]", summary: "Unstake from a pool; withdrawable after ~4 epochs.", example: "stake:unstake legends.pool.f863973.m0 all", chains: ["near"] },
    withdraw: { usage: "stake:withdraw <pool> [<amount> | all]", summary: "Withdraw unstaked NEAR from a pool.", chains: ["near"] },
    native: {
      usage: "stake:native <amount> <validator public key>",
      summary: "Stake action: lock NEAR as a validator with this key (0 stops).",
      chains: ["near"],
    },
    "@staked": { usage: "@stake:staked(<pool> [account])", summary: "Staked balance in yoctoNEAR." },
    "@unstaked": { usage: "@stake:unstaked(<pool> [account])", summary: "Unstaked (not yet withdrawn) balance in yoctoNEAR." },
    "@withdrawable": { usage: "@stake:withdrawable(<pool> [account])", summary: "true when unstaked NEAR can be withdrawn now." },
  },
};
