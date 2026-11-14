import { encodeCall } from "../evm/tx.js";
import type { IntentToken } from "../env.js";
import { units } from "../format.js";
import type { Expr } from "../lang/ast.js";
import { asInt, asString, scale } from "../plan/eval.js";
import type { PlanCtx } from "../plan/planner.js";
import type { IntentsWaitStep, NearAction } from "../plan/types.js";
import { INTENTS_CHAINS } from "../registry.js";
import { DEFAULT_CALL_GAS } from "./std.js";
import { checkHolds, registration } from "./token.js";
import type { Module } from "./types.js";
import { arity, onlyOpts } from "./types.js";

const USAGE = 'intents:swap <amount> from <chain:TOKEN> to <chain:TOKEN> [--from-wallet] [--to <recipient>] [--path "p"] [--slippage <percent>] [--deadline <minutes>]';
const MIN_SECONDS_LEFT = 600n;
const DEFAULT_DEADLINE_MIN = 60n;
const DEFAULT_SLIPPAGE_BPS = 50n;

interface AssetRef {
  /** Nearcast chain name when known (near, base, ...), else the raw 1Click id. */
  chain: string;
  /** 1Click blockchain id. */
  blockchain: string;
  token: IntentToken;
}

/** "base:USDC" -> the 1Click token. Deprecated duplicates are skipped; nep141 wins ties. */
async function asset(ctx: PlanCtx, ref: string): Promise<AssetRef> {
  const m = /^([A-Za-z0-9_-]+):([A-Za-z0-9_.$-]+)$/.exec(ref);
  if (!m) throw new Error(`asset must look like chain:SYMBOL (base:USDC, near:USDC, arbitrum:ETH), got ${ref}`);
  const [, chain, sym] = m;
  const blockchain = INTENTS_CHAINS[chain] ?? chain;
  const all = await ctx.env.intents.tokens();
  if (!all.some((t) => t.blockchain === blockchain)) {
    throw new Error(`NEAR Intents has no chain "${chain}" (try: ${Object.keys(INTENTS_CHAINS).join(", ")}, or a 1Click id like tron)`);
  }
  const onChain = all.filter((t) => t.blockchain === blockchain && !/DEPRECATED/i.test(t.symbol));
  const hits = onChain.filter((t) => t.symbol.toLowerCase() === sym.toLowerCase());
  const token = hits.find((t) => t.assetId.startsWith("nep141:")) ?? hits[0];
  if (!token) {
    throw new Error(`NEAR Intents has no ${sym} on ${chain} (has: ${[...new Set(onChain.map((t) => t.symbol))].slice(0, 25).join(", ")})`);
  }
  return { chain, blockchain, token };
}

/** The address this NEAR account controls on a chain: itself on NEAR, a Chain Signatures address elsewhere. */
async function ownAddress(ctx: PlanCtx, chain: string, path: string): Promise<string | null> {
  if (chain === "near") return ctx.sender;
  let c;
  try {
    c = ctx.env.chain(chain);
  } catch {
    return null;
  }
  if (c.kind === "evm") return ctx.env.evm.derive(ctx.sender, path);
  if (c.kind === "btc") return (await ctx.env.btc.derive(ctx.sender, path)).address;
  return ctx.env.sol.derive(ctx.sender, path);
}

const str = (value: string, line: number): Expr => ({ kind: "str", value, loc: { line, col: 0 } });
const num = (n: bigint, line: number): Expr => ({ kind: "num", raw: String(n), digits: n, exp: 0, loc: { line, col: 0 } });

export const intents: Module = {
  name: "intents",
  summary: "NEAR Intents: bridge or swap between NEAR, EVM chains, Bitcoin and Solana (mainnet).",
  commands: {
    async swap(ctx, cmd) {
      // `from` and `to` are optional connecting words: `intents:swap 10 from base:USDC to arbitrum:USDC`.
      const args = cmd.args.filter((a) => !(a.kind === "word" && (a.value === "from" || a.value === "to")));
      arity(args, 3, 3, USAGE);
      onlyOpts(cmd, ["to", "path", "slippage", "deadline", "from-wallet"], "intents:swap");
      const fromWallet = cmd.opts["from-wallet"] !== undefined && (await ctx.eval(cmd.opts["from-wallet"])) !== false;
      if (ctx.env.near.network !== "mainnet") {
        throw new Error("NEAR Intents runs on mainnet only: simulate this with --network mainnet (the UI's network switch)");
      }
      const from = await asset(ctx, asString(await ctx.eval(args[1]), "from"));
      const to = await asset(ctx, asString(await ctx.eval(args[2]), "to"));
      // Inside batch ( ... ) only NEAR deposits fit: they are actions on the token contract.
      if (ctx.scopeKind === "batch" ? from.chain !== "near" || fromWallet : ctx.scopeKind !== "seq") {
        throw new Error(ctx.scopeKind === "batch"
          ? "inside batch ( ... ), intents:swap can only deposit from near (e.g. near:USDC)"
          : "intents:swap must be at the top level of the script or inside batch ( ... )");
      }
      const amount = scale(await ctx.eval(args[0]), from.token.decimals, "amount");
      if (amount <= 0n) throw new Error("amount must be greater than zero");
      const path = cmd.opts.path ? asString(await ctx.eval(cmd.opts.path), "--path") : "intents";
      const slippage = cmd.opts.slippage ? scale(await ctx.eval(cmd.opts.slippage), 2, "--slippage") : DEFAULT_SLIPPAGE_BPS;
      if (slippage > 1000n) throw new Error("--slippage above 10% is refused");
      const minutes = cmd.opts.deadline ? asInt(await ctx.eval(cmd.opts.deadline), "--deadline") : DEFAULT_DEADLINE_MIN;
      if (minutes < 15n || minutes > 24n * 60n) throw new Error("--deadline must be between 15 and 1440 minutes");

      // Who pays in, who receives, who gets a refund.
      //  - default: addresses this NEAR account controls (itself on NEAR, Chain Signatures elsewhere)
      //  - --from-wallet: the EVM wallet connected in the browser pays, and gets refunds and EVM deliveries
      let depositor: string | null;
      let eoa: `0x${string}` | undefined;
      if (fromWallet) {
        eoa = ctx.env.evmWallet;
        if (!eoa) throw new Error("--from-wallet needs an EVM wallet (MetaMask) connected in the web UI");
        let c;
        try {
          c = ctx.env.chain(from.chain);
        } catch {
          c = null;
        }
        if (c?.kind !== "evm") throw new Error(`--from-wallet deposits from an EVM chain; ${from.chain} is not one`);
        depositor = eoa;
      } else {
        depositor = await ownAddress(ctx, from.chain, path);
        if (!depositor) throw new Error(`cannot deposit from ${from.chain}: Nearcast signs on near, ${ctx.env.chainNames().join(", ")}`);
      }
      let recipient: string | null = cmd.opts.to ? asString(await ctx.eval(cmd.opts.to), "--to") : null;
      if (!recipient && eoa) {
        let dest;
        try {
          dest = ctx.env.chain(to.chain);
        } catch {
          dest = null;
        }
        if (dest?.kind === "evm") recipient = eoa;
        else if (to.chain === "near" && ctx.sender !== eoa.toLowerCase()) recipient = ctx.sender;
        if (!recipient) throw new Error(`with --from-wallet, give the recipient on ${to.chain}: --to <address>`);
      }
      recipient ??= await ownAddress(ctx, to.chain, path);
      if (!recipient) throw new Error(`no address of yours on ${to.chain}: pass --to <recipient>`);

      const deadline = new Date(Date.now() + Number(minutes) * 60_000).toISOString();
      const res = await ctx.env.intents.quote({
        dry: false,
        swapType: "EXACT_INPUT",
        slippageTolerance: Number(slippage),
        originAsset: from.token.assetId,
        depositType: "ORIGIN_CHAIN",
        destinationAsset: to.token.assetId,
        amount: amount.toString(),
        refundTo: depositor,
        refundType: "ORIGIN_CHAIN",
        recipient,
        recipientType: "DESTINATION_CHAIN",
        deadline,
      });
      const q = res?.quote;
      if (!q?.depositAddress) throw new Error(`NEAR Intents returned no deposit address (${JSON.stringify(res).slice(0, 200)})`);
      if (q.depositMemo) throw new Error(`this route needs a deposit memo (${from.chain}), which Nearcast cannot attach yet`);
      const deposit = String(q.depositAddress);
      const quoteDeadline = String(q.deadline ?? deadline);
      const fromHuman = `${units(amount, from.token.decimals)} ${from.token.symbol} on ${from.chain}`;
      const outHuman = `${units(BigInt(q.amountOut), to.token.decimals)} ${to.token.symbol} on ${to.chain}`;

      // 1. Re-checked right before depositing: never fund an address that is about to go inactive.
      await ctx.gate(
        { kind: "helper", module: "intents", name: "seconds-left", args: [str(quoteDeadline, cmd.loc.line)], loc: cmd.loc },
        ">",
        num(MIN_SECONDS_LEFT, cmd.loc.line),
        `NEAR Intents quote still valid (deposit address ${deposit.slice(0, 10)}… goes inactive at ${quoteDeadline})`,
      );

      // 2. The deposit, signed by NEAR: a NEAR transaction, or Chain Signatures on the origin chain.
      const t = from.token;
      if (from.chain === "near") {
        if (!t.contractAddress) throw new Error(`cannot deposit native ${t.symbol} from NEAR; wrap it first (token:wrap) and use near:wNEAR`);
        const actions: NearAction[] = [];
        const reg = await registration(ctx, t.contractAddress, deposit);
        if (reg) actions.push(reg);
        actions.push({
          kind: "call", method: "ft_transfer", args: { receiver_id: deposit, amount: amount.toString() }, deposit: 1n, gas: DEFAULT_CALL_GAS,
          decoded: `ft_transfer: deposit ${units(amount, t.decimals)} ${t.symbol} (${amount} base units) to the NEAR Intents address ${deposit}`,
        });
        await checkHolds(ctx, { id: t.contractAddress, decimals: t.decimals, symbol: t.symbol }, amount, `${units(amount, t.decimals)} ${t.symbol}`, cmd.loc.line);
        await ctx.near({ receiver: t.contractAddress, actions, atomic: actions.length > 1, description: `deposit ${fromHuman} into NEAR Intents` });
      } else if (eoa) {
        // The user's own wallet signs: no Chain Signatures, no NEAR fees.
        const chain = ctx.env.chain(from.chain);
        if (chain.kind !== "evm") throw new Error("internal: --from-wallet on a non-EVM chain");
        if (t.contractAddress) {
          const call = encodeCall("transfer(address,uint256)", [deposit, amount]);
          const have = await ctx.env.evm.erc20Balance(chain, t.contractAddress as `0x${string}`, eoa);
          if (have < amount) {
            ctx.checks.push({ level: "fail", description: `line ${cmd.loc.line}: your wallet ${eoa} holds ${units(have, t.decimals)} ${t.symbol} on ${chain.label}, less than ${units(amount, t.decimals)}` });
          }
          await ctx.evmWalletCall(chain, eoa, {
            to: t.contractAddress as `0x${string}`, signature: "transfer(address,uint256)", args: call.args, data: call.data, value: 0n,
            decoded: call.decoded,
            description: `from your wallet on ${chain.label}, deposit ${units(amount, t.decimals)} ${t.symbol} into NEAR Intents (${deposit})`,
          });
        } else {
          await ctx.evmWalletCall(chain, eoa, {
            to: deposit as `0x${string}`, signature: "", args: [], data: "0x", value: amount,
            decoded: `send ${units(amount, 18)} ${chain.symbol} (${amount} wei)`,
            description: `from your wallet on ${chain.label}, deposit ${units(amount, 18)} ${chain.symbol} into NEAR Intents (${deposit})`,
          });
        }
      } else {
        const chain = ctx.env.chain(from.chain);
        if (chain.kind === "evm") {
          const sender = depositor as `0x${string}`;
          if (t.contractAddress) {
            const call = encodeCall("transfer(address,uint256)", [deposit, amount]);
            const have = await ctx.env.evm.erc20Balance(chain, t.contractAddress as `0x${string}`, sender);
            if (have < amount) {
              ctx.checks.push({ level: "fail", description: `line ${cmd.loc.line}: ${sender} on ${chain.label} holds ${units(have, t.decimals)} ${t.symbol}, less than ${units(amount, t.decimals)}` });
            }
            await ctx.evmCall(
              {
                to: t.contractAddress as `0x${string}`, signature: "transfer(address,uint256)", args: call.args, data: call.data, value: 0n, gas: 100_000n,
                decoded: call.decoded,
                description: `on ${chain.label}, deposit ${units(amount, t.decimals)} ${t.symbol} into NEAR Intents (${deposit})`,
              },
              { chain, path, sender },
            );
          } else {
            await ctx.evmCall(
              {
                to: deposit as `0x${string}`, signature: "", args: [], data: "0x", value: amount, gas: 21_000n,
                decoded: `send ${units(amount, 18)} ${chain.symbol} (${amount} wei)`,
                description: `on ${chain.label}, deposit ${units(amount, 18)} ${chain.symbol} into NEAR Intents (${deposit})`,
              },
              { chain, path, sender },
            );
          }
        } else if (t.contractAddress) {
          throw new Error(`only native ${chain.kind === "btc" ? "BTC" : "SOL"} can be deposited from ${chain.label} for now`);
        } else if (chain.kind === "btc") {
          await ctx.btcTransfer(chain, path, deposit, amount);
        } else {
          await ctx.solTransfer(chain, path, deposit, amount);
        }
      }
      // 3. Wait for the solvers. Sends nothing; resumable like any step. Inside a batch, it follows
      //    the batch's transaction, which is only built at the end of the block.
      ctx.afterTx((depositStep) => ctx.pushStep<IntentsWaitStep>(
        (base) => ({
          ...base,
          type: "intents-wait",
          depositAddress: deposit,
          depositStep,
          from: { chain: from.chain, label: from.chain, symbol: t.symbol, assetId: t.assetId, amount, decimals: t.decimals, refundTo: depositor },
          to: {
            chain: to.chain, label: to.chain, symbol: to.token.symbol, assetId: to.token.assetId,
            amountOut: BigInt(q.amountOut), minAmountOut: BigInt(q.minAmountOut ?? q.amountOut), decimals: to.token.decimals, recipient,
          },
          deadline: quoteDeadline,
          timeEstimate: Number(q.timeEstimate ?? 0),
          correlationId: res.correlationId,
        }),
        `NEAR Intents delivers about ${outHuman} to ${recipient}`,
      ));
      ctx.prints.push(`intents: ${fromHuman} -> about ${outHuman} (minimum ${units(BigInt(q.minAmountOut ?? q.amountOut), to.token.decimals)}), ~${q.timeEstimate ?? "?"}s`);
    },
  },
  helpers: {
    async "seconds-left"(_ctx, args) {
      arity(args, 1, 1, '@intents:seconds-left("<ISO time>")');
      const t = Date.parse(asString(args[0], "time"));
      if (Number.isNaN(t)) throw new Error("not a time");
      return BigInt(Math.floor((t - Date.now()) / 1000));
    },
  },
  docs: {
    swap: {
      usage: USAGE,
      summary: "Bridge or swap through NEAR Intents. Your NEAR account signs the deposit; solvers deliver on the other chain.",
      details: "Mainnet only. Several swaps from the same NEAR token can share one transaction: wrap them in batch ( ... ). `from`/`to` are optional. Same token on two chains = bridge (base:USDC → arbitrum:USDC). Recipient and refund default to addresses this NEAR account controls. The quote is re-checked before depositing; unfilled swaps are refunded.",
      example: "intents:swap 100 from base:USDC to arbitrum:USDC --from-wallet",
      opts: [
        { name: "from-wallet", summary: "deposit from the EVM wallet connected in the UI (MetaMask); refunds go back to it" },
        { name: "to", value: "<recipient>", summary: "receiver on the destination chain (default: yours)" },
        { name: "path", value: '"p"', summary: 'Chain Signatures path for your addresses (default "intents")' },
        { name: "slippage", value: "<percent>", summary: "max price slippage, default 0.5" },
        { name: "deadline", value: "<minutes>", summary: "quote lifetime, default 60" },
      ],
      chains: ["near", "evm", "bitcoin", "solana"],
    },
    "@seconds-left": { usage: '@intents:seconds-left("<ISO time>")', summary: "Seconds until a time (used to re-check quote deadlines)." },
  },
};
