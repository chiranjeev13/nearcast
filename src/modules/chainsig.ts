import { encodeCall } from "../evm/tx.js";
import { units } from "../format.js";
import type { EvalCtx } from "../plan/eval.js";
import { asInt, asString, scale } from "../plan/eval.js";
import { EVM_TOKENS } from "../registry.js";
import type { Module } from "./types.js";
import { arity, onlyOpts } from "./types.js";

function tokenAddress(chainId: number, label: string, v: string): `0x${string}` {
  const a = EVM_TOKENS[chainId]?.[v] ?? v;
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`unknown asset "${v}" on ${label}; use the native symbol, a known token, or a token address`);
  return a as `0x${string}`;
}

/** Whole-coin amount ("0.01", 1) to base units; literals with an exponent (1e15) are already base units. */
async function coinAmount(ctx: any, e: any, decimals: number): Promise<bigint> {
  const v = await ctx.eval(e);
  if (e.kind === "num" && /e/.test(e.raw)) return asInt(v, "amount");
  return scale(v, decimals, "amount");
}

export const chainsig: Module = {
  name: "chainsig",
  summary: "Chain Signatures: this NEAR account controls addresses on EVM chains, Bitcoin and Solana.",
  commands: {
    async on(ctx, cmd) {
      if (cmd.args.length !== 2 || !cmd.block) throw new Error('usage: chainsig:on <chain> "<path>" ( exec ... )');
      // Inside batch ( ... ) only the signature requests are batched; the calls still run one by one.
      if (ctx.scopeKind !== "seq" && ctx.scopeKind !== "batch") throw new Error("chainsig:on cannot be nested");
      const chain = ctx.env.chain(asString(await ctx.eval(cmd.args[0]), "chain"));
      if (chain.kind !== "evm") throw new Error(`chainsig:on runs EVM calls; for ${chain.label} use chainsig:transfer`);
      const path = asString(await ctx.eval(cmd.args[1]), "path");
      const sender = await ctx.env.evm.derive(ctx.sender, path);
      ctx.evm = { chain, path, sender };
      try {
        await ctx.block(cmd.block, { kind: "evm" });
      } finally {
        ctx.evm = undefined;
      }
    },

    async exec(ctx, cmd) {
      if (!ctx.evm) throw new Error('exec is only valid inside chainsig:on <chain> "<path>" ( ... )');
      if (cmd.args.length < 2) throw new Error('usage: exec <target> "<signature>" [args...] [--value <wei>] [--gas <limit>]');
      onlyOpts(cmd, ["value", "gas"], "exec");
      const { chain } = ctx.evm;
      const to = asString(await ctx.eval(cmd.args[0]), "target");
      if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error(`exec target must be an EVM address, got ${to}`);
      const signature = asString(await ctx.eval(cmd.args[1]), "function signature");
      const argValues = [];
      for (const a of cmd.args.slice(2)) argValues.push(await ctx.eval(a));
      const call = encodeCall(signature, argValues);
      const value = cmd.opts.value ? asInt(await ctx.eval(cmd.opts.value), "--value") : 0n;
      const gas = cmd.opts.gas ? asInt(await ctx.eval(cmd.opts.gas), "--gas") : undefined;

      let note = "";
      const sym = Object.entries(EVM_TOKENS[chain.chainId] ?? {}).find(([, a]) => a.toLowerCase() === to.toLowerCase())?.[0];
      if (sym && (call.fn.name === "transfer" || call.fn.name === "approve") && signature.replace(/\s/g, "").endsWith("(address,uint256)")) {
        const dec = await ctx.env.evm.erc20Decimals(chain, to as `0x${string}`);
        const [who, amt] = call.args as [string, bigint];
        note = call.fn.name === "transfer"
          ? `: send ${units(amt, dec)} ${sym} to ${who}`
          : `: allow ${who} to spend ${units(amt, dec)} ${sym}`;
      }
      await ctx.evmCall({
        to: to as `0x${string}`,
        signature,
        args: call.args,
        decoded: call.decoded,
        data: call.data,
        value,
        gas,
        description: `on ${chain.label}, call ${sym ?? to}.${call.decoded}${note}` +
          (value ? `, sending ${units(value, 18)} ${chain.symbol}` : ""),
      });
    },

    async transfer(ctx, cmd) {
      arity(cmd.args, 4, 4, 'chainsig:transfer <chain> "<path>" <to> <amount>');
      onlyOpts(cmd, [], "chainsig:transfer");
      const chain = ctx.env.chain(asString(await ctx.eval(cmd.args[0]), "chain"));
      const path = asString(await ctx.eval(cmd.args[1]), "path");
      const to = asString(await ctx.eval(cmd.args[2]), "recipient");
      if (chain.kind === "evm") {
        if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error(`recipient must be an EVM address, got ${to}`);
        const amount = await coinAmount(ctx, cmd.args[3], 18);
        const sender = await ctx.env.evm.derive(ctx.sender, path);
        await ctx.evmCall(
          {
            to: to as `0x${string}`, signature: "", args: [], data: "0x", value: amount,
            decoded: `send ${units(amount, 18)} ${chain.symbol} (${amount} wei)`,
            description: `on ${chain.label}, send ${units(amount, 18)} ${chain.symbol} to ${to}`,
          },
          { chain, path, sender },
        );
        return;
      }
      if (chain.kind === "btc") {
        const amount = await coinAmount(ctx, cmd.args[3], 8);
        if (amount < 546n) throw new Error("Bitcoin payments below 546 sats are dust and are not relayed");
        await ctx.btcTransfer(chain, path, to, amount);
        return;
      }
      const amount = await coinAmount(ctx, cmd.args[3], 9);
      await ctx.solTransfer(chain, path, to, amount);
    },
  },
  helpers: {
    async address(ctx, args) {
      arity(args, 2, 2, '@chainsig:address(<chain> "<path>")');
      const chain = ctx.env.chain(asString(args[0], "chain"));
      const path = asString(args[1], "path");
      const who = (ctx as any).sender ?? ctx.env.near.accountId;
      if (chain.kind === "evm") return ctx.env.evm.derive(who, path);
      if (chain.kind === "btc") return (await ctx.env.btc.derive(who, path)).address;
      return ctx.env.sol.derive(who, path);
    },

    async balance(ctx, args) {
      arity(args, 2, 3, '@chainsig:balance(<chain> "<path>" [native | token])');
      const chain = ctx.env.chain(asString(args[0], "chain"));
      const path = asString(args[1], "path");
      const who = (ctx as any).sender ?? ctx.env.near.accountId;
      const asset = args[2] === undefined ? "native" : asString(args[2], "asset");
      if (chain.kind === "btc") return ctx.env.btc.balance(chain, (await ctx.env.btc.derive(who, path)).address);
      if (chain.kind === "sol") return ctx.env.sol.balance(chain, await ctx.env.sol.derive(who, path));
      const addr = await ctx.env.evm.derive(who, path);
      if (asset === "native" || asset === chain.symbol || asset === "ETH") return ctx.env.evm.balance(chain, addr);
      return ctx.env.evm.erc20Balance(chain, tokenAddress(chain.chainId, chain.label, asset), addr);
    },
  },
  docs: {
    on: {
      usage: 'chainsig:on <chain> "<path>" ( exec ... )',
      summary: "Run EVM calls from the address this account controls for <path>, signed by NEAR's MPC network.",
      example: 'chainsig:on base "treasury" (\n  exec @token(USDC) "transfer(address,uint256)" 0x…dEaD 1e6\n)',
      block: true,
      chains: ["evm"],
    },
    exec: {
      usage: 'exec <target> "<function signature>" [args...] [--value <wei>] [--gas <limit>]',
      summary: "One EVM contract call, inside chainsig:on.",
      example: 'exec 0xC02a…6Cc2 "deposit()" --value 1e15',
      opts: [
        { name: "value", value: "<wei>", summary: "native coin sent with the call" },
        { name: "gas", value: "<limit>", summary: "gas limit (default: estimate x1.3)" },
      ],
      chains: ["evm"],
    },
    transfer: {
      usage: 'chainsig:transfer <chain> "<path>" <to> <amount>',
      summary: "Send the native coin (ETH, POL, BNB, BTC, SOL) from a derived address. Amount in whole coins.",
      details: "Bitcoin: P2WPKH, inputs and fee pinned at plan time. Solana: built right before signing; re-signed if its blockhash expires.",
      example: 'chainsig:transfer bitcoin "vault" tb1q… 0.0001',
      chains: ["evm", "bitcoin", "solana"],
    },
    "@address": { usage: '@chainsig:address(<chain> "<path>")', summary: "Address this account controls on <chain> for <path>." },
    "@balance": {
      usage: '@chainsig:balance(<chain> "<path>" [native | token])',
      summary: "Balance of the derived address in base units (wei, sats, lamports).",
      example: 'assert @chainsig:balance(base "treasury" USDC) >= 1e6',
    },
  },
};

export type { EvalCtx };
