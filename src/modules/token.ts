import { units } from "../format.js";
import type { EvalCtx } from "../plan/eval.js";
import { asInt, asString, scale } from "../plan/eval.js";
import { EVM_TOKENS, NEAR_TOKENS as NEAR_TOKENS_BY_NET, TGAS } from "../registry.js";
import { near } from "../format.js";
import type { NearAction } from "../plan/types.js";

const NEAR_TOKENS = NEAR_TOKENS_BY_NET as Record<string, Record<string, string>>;
import { DEFAULT_CALL_GAS } from "./std.js";
import type { Module } from "./types.js";
import { arity, nearAmount, onlyOpts } from "./types.js";

/** Symbol or contract account -> NEP-141 contract account. */
export function nearToken(ctx: EvalCtx, v: unknown): string {
  const s = asString(v as any, "token");
  const known = NEAR_TOKENS[ctx.env.near.network]?.[s];
  if (known) return known;
  if (s.includes(".") || /^[0-9a-f]{64}$/.test(s)) return s;
  throw new Error(`unknown token "${s}" on NEAR ${ctx.env.near.network}; use a known symbol (${Object.keys(NEAR_TOKENS[ctx.env.near.network] ?? {}).join(", ")}) or the contract account`);
}

async function tokenInfo(ctx: EvalCtx, v: unknown): Promise<{ id: string; decimals: number; symbol: string; evm: boolean }> {
  if (ctx.evm) {
    const s = asString(v as any, "token");
    const addr = (EVM_TOKENS[ctx.evm.chain.chainId]?.[s] ?? s) as `0x${string}`;
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) throw new Error(`unknown token "${s}" on ${ctx.evm.chain.label}`);
    return { id: addr, decimals: await ctx.env.evm.erc20Decimals(ctx.evm.chain, addr), symbol: s, evm: true };
  }
  const id = nearToken(ctx, v);
  const meta = await ctx.env.near.view(id, "ft_metadata", {});
  return { id, decimals: Number(meta.decimals), symbol: String(meta.symbol), evm: false };
}

/** storage_deposit for `who` if the token contract does not know it yet. */
export async function registration(ctx: EvalCtx, id: string, who: string): Promise<NearAction | null> {
  const registered = await ctx.env.near.view(id, "storage_balance_of", { account_id: who });
  if (registered !== null) return null;
  const bounds = await ctx.env.near.view(id, "storage_balance_bounds", {});
  return {
    kind: "call",
    method: "storage_deposit",
    args: { account_id: who, registration_only: true },
    deposit: BigInt(bounds.min),
    gas: DEFAULT_CALL_GAS,
    decoded: `storage_deposit: register ${who} with the token contract (${near(BigInt(bounds.min))})`,
  };
}

export async function checkHolds(ctx: any, t: { id: string; decimals: number; symbol: string }, amount: bigint, human: string, line: number) {
  const have = BigInt(await ctx.env.near.view(t.id, "ft_balance_of", { account_id: ctx.sender }));
  if (have < amount) {
    ctx.checks.push({
      level: "fail",
      description: `line ${line}: ${ctx.sender} holds ${units(have, t.decimals)} ${t.symbol}, less than the ${human} to transfer`,
    });
  }
}

export const token: Module = {
  name: "token",
  summary: "Fungible tokens: NEP-141 on NEAR, ERC-20 inside chainsig:on.",
  commands: {
    /**
     * token:transfer <token> <recipient> <amount> [--memo "text"]
     * Amount is in whole tokens ("1", "0.5"). If the recipient is not registered with the token
     * contract, storage_deposit is added to the same atomic transaction.
     */
    async transfer(ctx, cmd) {
      arity(cmd.args, 3, 3, 'token:transfer <token> <recipient> <amount> [--memo "text"]');
      for (const k of Object.keys(cmd.opts)) if (k !== "memo") throw new Error(`token:transfer has no option --${k}`);
      if (ctx.evm) throw new Error("token:transfer is a NEAR (NEP-141) command; inside chainsig:on use exec");
      const t = await tokenInfo(ctx, await ctx.eval(cmd.args[0]));
      const to = asString(await ctx.eval(cmd.args[1]), "recipient");
      const amount = scale(await ctx.eval(cmd.args[2]), t.decimals, "amount");
      if (amount <= 0n) throw new Error("amount must be greater than zero");
      const memo = cmd.opts.memo ? asString(await ctx.eval(cmd.opts.memo), "--memo") : undefined;
      const human = `${units(amount, t.decimals)} ${t.symbol}`;

      const actions: NearAction[] = [];
      const reg = await registration(ctx, t.id, to);
      const registered = reg ? null : true;
      if (reg) actions.push(reg);
      actions.push({
        kind: "call",
        method: "ft_transfer",
        args: { receiver_id: to, amount: amount.toString(), ...(memo ? { memo } : {}) },
        deposit: 1n,
        gas: DEFAULT_CALL_GAS,
        decoded: `ft_transfer: send ${human} (${amount} base units) to ${to}`,
      });

      await checkHolds(ctx, t, amount, human, cmd.loc.line);
      await ctx.near({
        receiver: t.id,
        actions,
        atomic: actions.length > 1,
        description: `transfer ${human} to ${to}` + (registered === null ? ` (${to} is not registered for this token, so registration is included)` : ""),
      });
    },

    async "transfer-call"(ctx, cmd) {
      arity(cmd.args, 4, 4, 'token:transfer-call <token> <receiver> <amount> "<msg>"');
      onlyOpts(cmd, ["gas"], "token:transfer-call");
      if (ctx.evm) throw new Error("token:transfer-call is a NEAR (NEP-141) command");
      const t = await tokenInfo(ctx, await ctx.eval(cmd.args[0]));
      const to = asString(await ctx.eval(cmd.args[1]), "receiver");
      const amount = scale(await ctx.eval(cmd.args[2]), t.decimals, "amount");
      const msg = asString(await ctx.eval(cmd.args[3]), "msg");
      const gas = cmd.opts.gas ? asInt(await ctx.eval(cmd.opts.gas), "--gas") : 100n * TGAS;
      const human = `${units(amount, t.decimals)} ${t.symbol}`;
      const actions: NearAction[] = [];
      const reg = await registration(ctx, t.id, to);
      if (reg) actions.push(reg);
      actions.push({
        kind: "call", method: "ft_transfer_call", args: { receiver_id: to, amount: amount.toString(), msg }, deposit: 1n, gas,
        decoded: `ft_transfer_call: send ${human} (${amount} base units) to ${to}, msg ${JSON.stringify(msg)}`,
      });
      await checkHolds(ctx, t, amount, human, cmd.loc.line);
      await ctx.near({ receiver: t.id, actions, atomic: actions.length > 1, description: `send ${human} to ${to} and call it` });
    },

    async register(ctx, cmd) {
      arity(cmd.args, 1, 2, "token:register <token> [account]");
      onlyOpts(cmd, [], "token:register");
      const id = nearToken(ctx, await ctx.eval(cmd.args[0]));
      const who = cmd.args[1] ? asString(await ctx.eval(cmd.args[1]), "account") : ctx.sender;
      const reg = await registration(ctx, id, who);
      if (!reg) {
        ctx.checks.push({ level: "warn", description: `line ${cmd.loc.line}: ${who} is already registered with ${id}; nothing to do` });
        return;
      }
      await ctx.near({ receiver: id, actions: [reg], description: `register ${who} with ${id}` });
    },

    async wrap(ctx, cmd) {
      arity(cmd.args, 1, 1, "token:wrap <amount>");
      onlyOpts(cmd, [], "token:wrap");
      const id = nearToken(ctx, "wNEAR");
      const amount = await nearAmount(ctx, cmd.args[0], "amount");
      const actions: NearAction[] = [];
      const reg = await registration(ctx, id, ctx.sender);
      if (reg) actions.push(reg);
      actions.push({ kind: "call", method: "near_deposit", args: {}, deposit: amount, gas: DEFAULT_CALL_GAS, decoded: `near_deposit: wrap ${near(amount)}` });
      await ctx.near({ receiver: id, actions, atomic: actions.length > 1, description: `wrap ${near(amount)} into wNEAR` });
    },

    async unwrap(ctx, cmd) {
      arity(cmd.args, 1, 1, "token:unwrap <amount>");
      onlyOpts(cmd, [], "token:unwrap");
      const id = nearToken(ctx, "wNEAR");
      const amount = await nearAmount(ctx, cmd.args[0], "amount");
      await ctx.near({
        receiver: id,
        actions: [{ kind: "call", method: "near_withdraw", args: { amount: amount.toString() }, deposit: 1n, gas: DEFAULT_CALL_GAS, decoded: `near_withdraw: unwrap ${near(amount)}` }],
        description: `unwrap ${near(amount)} of wNEAR back to NEAR`,
      });
    },
  },
  helpers: {
    /** @token:registered(TOKEN account) */
    async registered(ctx, args) {
      arity(args, 1, 2, "@token:registered(<token> [account])");
      const id = nearToken(ctx, args[0]);
      const who = args[1] === undefined ? ctx.env.near.accountId : asString(args[1], "account");
      return (await ctx.env.near.view(id, "storage_balance_of", { account_id: who })) !== null;
    },

    /** @token:amount(TOKEN 1.5): whole tokens -> base units, using the token's decimals. */
    async amount(ctx, args) {
      arity(args, 2, 2, "@token:amount(<token> <amount>)");
      const t = await tokenInfo(ctx, args[0]);
      return scale(args[1], t.decimals, "amount");
    },

    /** @token:balance(TOKEN [account]): balance in base units. Defaults to the script's own account. */
    async balance(ctx, args) {
      arity(args, 1, 2, "@token:balance(<token> [account])");
      const t = await tokenInfo(ctx, args[0]);
      if (t.evm) {
        const owner = (args[1] ? asString(args[1], "account") : ctx.evm!.sender) as `0x${string}`;
        return ctx.env.evm.erc20Balance(ctx.evm!.chain, t.id as `0x${string}`, owner);
      }
      const owner = args[1] ? asString(args[1], "account") : ctx.env.near.accountId;
      return asInt(await ctx.env.near.view(t.id, "ft_balance_of", { account_id: owner }), "balance");
    },

    /** @token:decimals(TOKEN) */
    async decimals(ctx, args) {
      arity(args, 1, 1, "@token:decimals(<token>)");
      return BigInt((await tokenInfo(ctx, args[0])).decimals);
    },
  },
  docs: {
    transfer: {
      usage: 'token:transfer <token> <recipient> <amount> [--memo "text"]',
      summary: "Send a NEP-141 token. Amount in whole tokens; registers the recipient if needed, atomically.",
      example: "token:transfer USDC alice.testnet 1.5",
      opts: [{ name: "memo", value: '"text"', summary: "memo stored with the transfer" }],
      chains: ["near"],
    },
    "transfer-call": {
      usage: 'token:transfer-call <token> <receiver> <amount> "<msg>"',
      summary: "Send tokens to a contract and call ft_on_transfer on it (deposits into DEXes, etc.).",
      opts: [{ name: "gas", value: "<amount>", summary: "default 100tgas" }],
      chains: ["near"],
    },
    register: { usage: "token:register <token> [account]", summary: "Pay the token's storage deposit for an account.", chains: ["near"] },
    wrap: { usage: "token:wrap <amount>", summary: "Wrap NEAR into wNEAR.", example: "token:wrap 1", chains: ["near"] },
    unwrap: { usage: "token:unwrap <amount>", summary: "Unwrap wNEAR back to NEAR.", chains: ["near"] },
    "@registered": { usage: "@token:registered(<token> [account])", summary: "true if the account is registered with the token." },
    "@amount": { usage: "@token:amount(<token> <amount>)", summary: "Whole tokens to base units, using the token's decimals.", example: "@token:amount(USDC 1.5)" },
    "@balance": { usage: "@token:balance(<token> [account])", summary: "Balance in base units (inside chainsig:on: the ERC-20 balance)." },
    "@decimals": { usage: "@token:decimals(<token>)", summary: "Token decimals." },
  },
};
