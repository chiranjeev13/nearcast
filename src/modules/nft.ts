import { near } from "../format.js";
import { asInt, asString, show } from "../plan/eval.js";
import type { Value } from "../plan/types.js";
import { TGAS } from "../registry.js";
import { DEFAULT_CALL_GAS, fromJson } from "./std.js";
import type { Module } from "./types.js";
import { arity, nearAmount, onlyOpts } from "./types.js";

const tokenId = (v: Value): string => (typeof v === "bigint" ? v.toString() : asString(v, "token id"));

export const nft: Module = {
  name: "nft",
  summary: "Non-fungible tokens (NEP-171): transfer, approve, inspect.",
  commands: {
    async transfer(ctx, cmd) {
      arity(cmd.args, 3, 3, 'nft:transfer <contract> <token id> <receiver> [--memo "text"]');
      onlyOpts(cmd, ["memo"], "nft:transfer");
      const contract = asString(await ctx.eval(cmd.args[0]), "contract");
      const id = tokenId(await ctx.eval(cmd.args[1]));
      const to = asString(await ctx.eval(cmd.args[2]), "receiver");
      const memo = cmd.opts.memo ? asString(await ctx.eval(cmd.opts.memo), "--memo") : undefined;
      const token = await ctx.env.near.view(contract, "nft_token", { token_id: id });
      if (!token) ctx.checks.push({ level: "fail", description: `line ${ctx.line}: ${contract} has no token "${id}"` });
      else if (token.owner_id !== ctx.sender) {
        ctx.checks.push({ level: "warn", description: `line ${ctx.line}: token "${id}" is owned by ${token.owner_id}, not ${ctx.sender}; this only works with an approval` });
      }
      await ctx.near({
        receiver: contract,
        actions: [{
          kind: "call", method: "nft_transfer", args: { receiver_id: to, token_id: id, ...(memo ? { memo } : {}) },
          deposit: 1n, gas: DEFAULT_CALL_GAS, decoded: `nft_transfer: token "${id}" to ${to}`,
        }],
        description: `send NFT "${id}" from ${contract} to ${to}`,
      });
    },

    async "transfer-call"(ctx, cmd) {
      arity(cmd.args, 4, 4, 'nft:transfer-call <contract> <token id> <receiver> "<msg>"');
      onlyOpts(cmd, ["gas"], "nft:transfer-call");
      const contract = asString(await ctx.eval(cmd.args[0]), "contract");
      const id = tokenId(await ctx.eval(cmd.args[1]));
      const to = asString(await ctx.eval(cmd.args[2]), "receiver");
      const msg = asString(await ctx.eval(cmd.args[3]), "msg");
      const gas = cmd.opts.gas ? asInt(await ctx.eval(cmd.opts.gas), "--gas") : 100n * TGAS;
      await ctx.near({
        receiver: contract,
        actions: [{ kind: "call", method: "nft_transfer_call", args: { receiver_id: to, token_id: id, msg }, deposit: 1n, gas, decoded: `nft_transfer_call: token "${id}" to ${to}, msg ${JSON.stringify(msg)}` }],
        description: `send NFT "${id}" to ${to} and notify it`,
      });
    },

    async approve(ctx, cmd) {
      arity(cmd.args, 3, 3, 'nft:approve <contract> <token id> <account> [--msg "text"] [--deposit <amount>]');
      onlyOpts(cmd, ["msg", "deposit"], "nft:approve");
      const contract = asString(await ctx.eval(cmd.args[0]), "contract");
      const id = tokenId(await ctx.eval(cmd.args[1]));
      const who = asString(await ctx.eval(cmd.args[2]), "account");
      const msg = cmd.opts.msg ? asString(await ctx.eval(cmd.opts.msg), "--msg") : undefined;
      const deposit = cmd.opts.deposit ? await nearAmount(ctx, cmd.opts.deposit, "--deposit") : 10n ** 21n;
      await ctx.near({
        receiver: contract,
        actions: [{
          kind: "call", method: "nft_approve", args: { token_id: id, account_id: who, ...(msg ? { msg } : {}) },
          deposit, gas: DEFAULT_CALL_GAS + (msg ? 50n * TGAS : 0n), decoded: `nft_approve: let ${who} transfer token "${id}" (storage deposit ${near(deposit)})`,
        }],
        description: `allow ${who} to transfer NFT "${id}"`,
        danger: `${who} can transfer this token until revoked`,
      });
    },

    async revoke(ctx, cmd) {
      arity(cmd.args, 2, 3, "nft:revoke <contract> <token id> [account]");
      onlyOpts(cmd, [], "nft:revoke");
      const contract = asString(await ctx.eval(cmd.args[0]), "contract");
      const id = tokenId(await ctx.eval(cmd.args[1]));
      const who = cmd.args[2] ? asString(await ctx.eval(cmd.args[2]), "account") : undefined;
      await ctx.near({
        receiver: contract,
        actions: [who
          ? { kind: "call", method: "nft_revoke", args: { token_id: id, account_id: who }, deposit: 1n, gas: DEFAULT_CALL_GAS, decoded: `nft_revoke: ${who} on token "${id}"` }
          : { kind: "call", method: "nft_revoke_all", args: { token_id: id }, deposit: 1n, gas: DEFAULT_CALL_GAS, decoded: `nft_revoke_all on token "${id}"` }],
        description: who ? `revoke ${who}'s approval on NFT "${id}"` : `revoke every approval on NFT "${id}"`,
      });
    },
  },
  helpers: {
    async owner(ctx, args) {
      arity(args, 2, 2, "@nft:owner(<contract> <token id>)");
      const t = await ctx.env.near.view(asString(args[0], "contract"), "nft_token", { token_id: tokenId(args[1]) });
      return t ? t.owner_id : null;
    },
    async tokens(ctx, args) {
      arity(args, 1, 2, "@nft:tokens(<contract> [account])");
      const who = args[1] === undefined ? ctx.env.near.accountId : asString(args[1], "account");
      const list = await ctx.env.near.view(asString(args[0], "contract"), "nft_tokens_for_owner", { account_id: who, from_index: "0", limit: 100 });
      return (list ?? []).map((t: any) => String(t.token_id));
    },
    async count(ctx, args) {
      arity(args, 1, 2, "@nft:count(<contract> [account])");
      const contract = asString(args[0], "contract");
      if (args[1] === undefined) return asInt(String(await ctx.env.near.view(contract, "nft_total_supply", {})), "supply");
      return asInt(String(await ctx.env.near.view(contract, "nft_supply_for_owner", { account_id: asString(args[1], "account") })), "count");
    },
    async metadata(ctx, args) {
      arity(args, 1, 2, "@nft:metadata(<contract> [token id])");
      const contract = asString(args[0], "contract");
      if (args[1] === undefined) return fromJson(await ctx.env.near.view(contract, "nft_metadata", {}));
      const t = await ctx.env.near.view(contract, "nft_token", { token_id: tokenId(args[1]) });
      if (!t) throw new Error(`${contract} has no token ${show(args[1])}`);
      return fromJson(t.metadata ?? null);
    },
  },
  docs: {
    transfer: {
      usage: 'nft:transfer <contract> <token id> <receiver> [--memo "text"]',
      summary: "Transfer an NFT (attaches the required 1 yoctoNEAR).",
      example: 'nft:transfer nft.examples.testnet "42" bob.testnet',
      opts: [{ name: "memo", value: '"text"', summary: "memo stored with the transfer" }],
      chains: ["near"],
    },
    "transfer-call": {
      usage: 'nft:transfer-call <contract> <token id> <receiver> "<msg>"',
      summary: "Transfer an NFT to a contract and call nft_on_transfer on it.",
      opts: [{ name: "gas", value: "<amount>", summary: "default 100tgas" }],
      chains: ["near"],
    },
    approve: {
      usage: 'nft:approve <contract> <token id> <account> [--msg "text"] [--deposit <amount>]',
      summary: "Let another account transfer one of your NFTs.",
      opts: [
        { name: "msg", value: '"text"', summary: "calls nft_on_approve on the account" },
        { name: "deposit", value: "<amount>", summary: "storage deposit (default 0.001 NEAR)" },
      ],
      chains: ["near"],
    },
    revoke: { usage: "nft:revoke <contract> <token id> [account]", summary: "Revoke one approval, or all without an account.", chains: ["near"] },
    "@owner": { usage: "@nft:owner(<contract> <token id>)", summary: "Owner of a token, or null." },
    "@tokens": { usage: "@nft:tokens(<contract> [account])", summary: "Token ids owned (first 100)." },
    "@count": { usage: "@nft:count(<contract> [account])", summary: "Total supply, or how many an account owns." },
    "@metadata": { usage: "@nft:metadata(<contract> [token id])", summary: "Contract metadata, or one token's metadata." },
  },
};
