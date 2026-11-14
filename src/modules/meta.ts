import { describeSignedDelegate } from "../near/tx.js";
import { asInt, asString } from "../plan/eval.js";
import type { Module } from "./types.js";
import { arity, onlyOpts } from "./types.js";

const DEFAULT_TTL = 600n; // blocks, about 10 minutes

export const meta: Module = {
  name: "meta",
  summary: "Meta transactions (NEP-366): one account signs, another pays the gas.",
  commands: {
    async relay(ctx, cmd) {
      if (cmd.args.length || !cmd.block) throw new Error("usage: meta:relay --relayer <account> ( ... )");
      onlyOpts(cmd, ["relayer", "ttl"], "meta:relay");
      if (!cmd.opts.relayer) throw new Error("meta:relay needs --relayer <account>: who pays the gas");
      const relayer = asString(await ctx.eval(cmd.opts.relayer), "--relayer");
      const ttl = cmd.opts.ttl ? asInt(await ctx.eval(cmd.opts.ttl), "--ttl") : DEFAULT_TTL;
      await ctx.meta(cmd, relayer, Number(ttl));
    },

    async sign(ctx, cmd) {
      if (cmd.args.length || !cmd.block) throw new Error("usage: meta:sign ( ... )");
      onlyOpts(cmd, ["ttl"], "meta:sign");
      const ttl = cmd.opts.ttl ? asInt(await ctx.eval(cmd.opts.ttl), "--ttl") : DEFAULT_TTL;
      await ctx.meta(cmd, null, Number(ttl));
    },

    async submit(ctx, cmd) {
      arity(cmd.args, 1, 1, "meta:submit <signed delegate, base64>");
      onlyOpts(cmd, [], "meta:submit");
      const b64 = asString(await ctx.eval(cmd.args[0]), "signed delegate");
      const d = describeSignedDelegate(b64);
      const height = await ctx.env.near.height();
      if (BigInt(height) > d.maxBlockHeight) {
        ctx.checks.push({ level: "fail", description: `line ${ctx.line}: this signed delegate expired at block ${d.maxBlockHeight} (now ${height})` });
      }
      await ctx.near({
        receiver: d.sender,
        actions: [{
          kind: "signed-delegate", base64: b64, sender: d.sender, receiver: d.receiver,
          decoded: `relay ${d.sender} → ${d.receiver}: ${d.actions.join("; ")}`,
        }],
        description: `pay for ${d.sender}'s signed meta transaction to ${d.receiver}`,
        danger: "you pay the gas and any deposits inside it",
      });
    },
  },
  helpers: {},
  docs: {
    relay: {
      usage: "meta:relay --relayer <account> [--ttl <blocks>] ( ... )",
      summary: "The signer signs the block's actions; the relayer sends them and pays gas and deposits.",
      details: "One receiver per block, like batch. Both accounts need local keys.",
      example: "meta:relay --relayer sponsor.testnet (\n  call counter.testnet increment\n)",
      opts: [
        { name: "relayer", value: "<account>", summary: "pays and sends" },
        { name: "ttl", value: "<blocks>", summary: "validity after signing (default 600)" },
      ],
      block: true,
      chains: ["near"],
    },
    sign: {
      usage: "meta:sign [--ttl <blocks>] ( ... )",
      summary: "Sign a meta transaction without sending it; the receipt shows it (base64) for any relayer.",
      opts: [{ name: "ttl", value: "<blocks>", summary: "validity after signing (default 600)" }],
      block: true,
      chains: ["near"],
    },
    submit: {
      usage: "meta:submit <signed delegate, base64>",
      summary: "Relay someone else's signed meta transaction, paying its gas.",
      chains: ["near"],
    },
  },
};
