import { eth, near, tgas, units } from "../format.js";
import { explorerUrl } from "../liveCore.js";
import { actionDeposit, actionGas, type NearAction, type Plan, type Step, type StepState } from "../plan/types.js";
import { planProblems } from "../plan/problems.js";
import type { PlanView, Risk, StepView } from "./api.js";

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const nearExact = (y: bigint) => (y === 0n ? "0 NEAR" : `${near(y)} (${y} yocto)`);
const RANK: Risk[] = ["read-only", "state-changing", "irreversible", "high-value"];

const IRREVERSIBLE = new Set<NearAction["kind"]>(["delete-account", "delete-key", "deploy", "deploy-global", "use-global"]);
const VALUE_METHODS = /^(ft_transfer|ft_transfer_call|nft_transfer|nft_transfer_call|near_deposit|near_withdraw|deposit_and_stake|create_account)$/;

function movesNear(a: NearAction): boolean {
  if (a.kind === "transfer" || a.kind === "stake") return true;
  if (a.kind === "call") return a.deposit > 1n || VALUE_METHODS.test(a.method);
  if (a.kind === "delegate") return a.actions.some(movesNear);
  return a.kind === "signed-delegate";
}

/** Risk tags for one step. Thresholds are deliberately low: the label is a prompt to look, not a verdict. */
export function stepRisk(s: Step, network: string): Risk[] {
  if (s.type === "assert" || s.type === "intents-wait") return ["read-only"];
  const tags = new Set<Risk>(["state-changing"]);
  const mainnet = network === "mainnet";
  if (s.type === "near-tx") {
    const all = s.actions.flatMap((a) => (a.kind === "delegate" ? [a, ...a.actions] : [a]));
    if (all.some((a) => IRREVERSIBLE.has(a.kind))) tags.add("irreversible");
    const value = s.actions.reduce((x, a) => x + actionDeposit(a), 0n) + all.reduce((x, a) => x + (a.kind === "stake" ? a.amount : 0n), 0n);
    if ((mainnet && all.some(movesNear)) || value >= 10n * 10n ** 24n) tags.add("high-value");
  } else if (s.type === "delegate-sign") {
    if (s.actions.some((a) => IRREVERSIBLE.has(a.kind))) tags.add("irreversible");
    if (mainnet && s.actions.some(movesNear)) tags.add("high-value");
  } else if (s.type === "evm-tx" || s.type === "evm-wallet-tx") {
    const erc20Out = /^(transfer|approve|transferFrom)\(/.test(s.decoded);
    if (s.value > 0n || erc20Out) tags.add("irreversible");
    if ((mainnet && (s.value > 0n || erc20Out)) || s.value >= 10n ** 17n) tags.add("high-value");
  } else if (s.type === "btc-tx") {
    tags.add("irreversible");
    if (mainnet || s.amount >= 100_000n) tags.add("high-value");
  } else if (s.type === "sol-tx") {
    tags.add("irreversible");
    if (mainnet || s.lamports >= 10n ** 9n) tags.add("high-value");
  }
  return RANK.filter((r) => tags.has(r));
}

/** Likely cause and the next safe action, from a step's error or wait reason. */
export function stepHint(s: Step, st: StepState): string | undefined {
  const e = st.error ?? "";
  if (st.status !== "failed" && !st.handoff) return undefined;
  if (st.handoff) return "wallet answer not recorded → check the wallet or explorer, then give the tx hash or mark it not sent";
  if (s.type === "assert") return "condition is false now → fix the balance or state it checks, then Resume (it is checked again)";
  if (/^wallet:/.test(e)) return "nothing was sent → Resume and retry to ask the wallet again";
  if (s.type === "evm-wallet-tx") return "reverted: gas was spent from your wallet → check the balance and the call, then simulate again";
  if (/NotEnoughBalance|LackBalanceForState|not enough NEAR/i.test(e)) return `insufficient NEAR on ${(s as any).sender} → fund it, then Resume and retry`;
  if (/AccountAlreadyExists/.test(e)) return "the account already exists → pick another name; earlier steps stay done";
  if (/AccountDoesNotExist/.test(e)) return "an account in this step does not exist → create or fix it, then Resume and retry";
  if (/InvalidNonce|nonce/i.test(e) && s.type === "near-tx") return "another transaction used this key's nonce → Resume signs again only after the old one provably expired";
  if (s.type === "near-tx" && s.purpose?.kind === "mpc-sign") return "the MPC network did not answer in time → Resume asks again (safe: a signature moves nothing)";
  if (s.type === "near-tx") return "a receipt failed; later receipts may have had effects → inspect in the explorer, then Resume and retry only if safe";
  if (s.type === "evm-tx") return "reverted: the nonce is used and gas spent → fix the cause and run the rest as a new script";
  if (s.type === "btc-tx") return "rejected by the Bitcoin network (inputs spent or fee too low?) → check the address, then plan a new run";
  if (s.type === "sol-tx") return "failed on Solana (balance or rent?) → check the address, then plan a new run";
  if (s.type === "delegate-sign") return "could not sign the meta transaction → check the sender's key, then Resume";
  if (s.type === "intents-wait") {
    return /refunded/.test(e)
      ? `funds went back to ${s.from.refundTo} → check the price/amount and simulate a new swap`
      : "the swap did not complete → check the deposit address in NEAR Intents' explorer before retrying";
  }
  return undefined;
}

function actionLine(a: NearAction): string {
  const g = actionGas(a);
  const d = actionDeposit(a);
  const extra = [d ? `deposit ${nearExact(d)}` : "", g && a.kind === "call" ? `gas ${tgas(g)}` : ""].filter(Boolean).join(", ");
  return a.decoded + (extra ? `  ·  ${extra}` : "");
}

const chainLabel = (s: Step, network: string) =>
  s.type === "intents-wait" ? "NEAR Intents"
    : s.type === "assert" ? (s.phase === "preflight" ? "preflight check" : "gate")
    : s.chain.kind === "near" ? `NEAR ${network}` : s.chain.label;

/** The step list as the UI and CLI show it. Built from the same Plan the executor and receipt use. */
export function planView(plan: Plan, state: Record<string, StepState> = {}, canSign: (id: string) => boolean = () => true): PlanView {
  const steps: StepView[] = plan.steps.map((s) => {
    const st = state[s.id] ?? { status: "planned" as const };
    const base = {
      n: s.index + 1, id: s.id, line: s.source.line, text: s.source.text, status: st.status, error: st.error,
      chain: chainLabel(s, plan.network), risk: stepRisk(s, plan.network), hint: stepHint(s, st),
      txHash: st.txHash, url: st.txHash && st.status !== "signed" && "chain" in s && s.type !== "delegate-sign" ? explorerUrl(plan.network, s.chain as any, st.txHash) : undefined,
    };
    if (s.type === "assert") {
      return {
        ...base, kind: "check", title: s.message ?? s.source.text, actions: [], atomic: false,
        rows: [["now", `${s.planResult.detail} is ${s.planResult.ok ? "true" : "false"}` + (s.phase === "gate" ? " (checked again when reached)" : "")]],
        result: typeof st.result === "string" ? st.result : undefined, url: undefined,
      };
    }
    if (s.type === "near-tx") {
      const wallet = !canSign(s.sender);
      return {
        ...base, kind: "near", title: cap(s.description),
        rows: [["from", s.sender], ["to", s.receiver], ["max fee", nearExact(s.maxFee)]],
        actions: s.actions.map(actionLine),
        atomic: s.actions.length > 1,
        danger: (s as any).danger,
        fee: st.feePaid ? near(BigInt(st.feePaid)) : undefined,
        signer: s.sender,
        signedWith: wallet ? "wallet" : "key",
      };
    }
    if (s.type === "delegate-sign") {
      const r = st.result as { signedDelegate?: string; validUntilBlock?: string } | undefined;
      return {
        ...base, kind: "local", chain: `NEAR ${plan.network} · not sent`, title: cap(s.description),
        rows: [["signer", s.sender], ["to", s.receiver], ["valid for", `${s.ttlBlocks} blocks after signing`],
          ...(r?.signedDelegate ? [["signed delegate", r.signedDelegate] as [string, string], ["valid until block", r.validUntilBlock ?? ""] as [string, string]] : [])],
        actions: s.actions.map(actionLine), atomic: s.actions.length > 1, signer: s.sender, signedWith: "key",
        result: r?.signedDelegate,
      };
    }
    if (s.type === "intents-wait") {
      const r = st.result as { status?: string; amountOutFormatted?: string; destinationTxs?: string[] } | undefined;
      const fmt = (x: bigint) => units(x, s.to.decimals);
      return {
        ...base, kind: "wait", title: cap(s.description), actions: [], atomic: false,
        rows: [
          ["deposit to", s.depositAddress],
          ["send", `${units(s.from.amount, s.from.decimals)} ${s.from.symbol} on ${s.from.chain} (${s.from.amount} base units)`],
          ["receive", `~${fmt(s.to.amountOut)} ${s.to.symbol} on ${s.to.chain}, at least ${fmt(s.to.minAmountOut)} ${s.to.symbol} (${s.to.minAmountOut} base units)`],
          ["recipient", s.to.recipient],
          ["refund to", s.from.refundTo],
          ["quote valid until", s.deadline],
          ["time", `~${s.timeEstimate}s after the deposit lands`],
          ...(r?.status ? [["status", r.status] as [string, string]] : []),
          ...(r?.destinationTxs ?? []).map((t) => ["delivered", t] as [string, string]),
        ],
        result: r?.amountOutFormatted ? `received ${r.amountOutFormatted} ${s.to.symbol}` : undefined,
        url: (r?.destinationTxs ?? []).find((t) => t.startsWith("http")),
      };
    }
    if (s.type === "evm-wallet-tx") {
      const sym = s.chain.symbol;
      return {
        ...base, kind: "evm", title: cap(s.description),
        rows: [
          ["from", `${s.from} (your wallet)`], ["to", s.to],
          ["call", s.data === "0x" ? "plain transfer" : s.decoded],
          ...(s.value ? [["value", `${units(s.value, 18)} ${sym} (${s.value} wei)`] as [string, string]] : []),
          ["gas", `simulated from your wallet: limit ${s.gas}, up to ${eth(s.maxFee).replace(/ETH$/, sym)}; your wallet sets nonce and fees`],
        ],
        actions: [], atomic: false, signedWith: "wallet", signer: s.from,
        fee: st.feePaid ? eth(BigInt(st.feePaid)).replace(/ETH$/, sym) : undefined,
      };
    }
    const from: [string, string] = ["from", `${s.sender} (derived from ${s.derivation.accountId}, path "${s.derivation.path}")`];
    if (s.type === "evm-tx") {
      const sym = s.chain.symbol;
      return {
        ...base, kind: "evm", title: cap(s.description),
        rows: [
          from, ["to", s.to],
          ["call", s.signature ? s.decoded : "plain transfer"],
          ...(s.value ? [["value", `${units(s.value, 18)} ${sym} (${s.value} wei)`] as [string, string]] : []),
          ["nonce", `${s.nonce} (pinned)`],
          ["max fee", `${eth(s.maxFee).replace(/ETH$/, sym)} (gas limit ${s.gas})`],
          ["signed by", `step ${Number(s.signedBy.slice(1))}`],
        ],
        actions: [], atomic: false, signedWith: "mpc",
        fee: st.feePaid ? eth(BigInt(st.feePaid)).replace(/ETH$/, sym) : undefined,
      };
    }
    if (s.type === "btc-tx") {
      return {
        ...base, kind: "btc", title: cap(s.description),
        rows: [
          from, ["to", s.to],
          ["amount", `${units(s.amount, 8)} BTC (${s.amount} sats)`],
          ["fee", `${units(s.fee, 8)} BTC (${s.fee} sats, pinned)`],
          ["inputs", s.inputs.map((i) => `${i.txid.slice(0, 10)}…:${i.vout} (${i.value} sats)`).join(", ")],
          ["signed by", s.signedBy.map((x) => `step ${Number(x.slice(1))}`).join(", ")],
        ],
        actions: [], atomic: false, signedWith: "mpc",
        fee: st.feePaid ? `${units(BigInt(st.feePaid), 8)} BTC` : undefined,
      };
    }
    return {
      ...base, kind: "sol", title: cap(s.description),
      rows: [
        from, ["to", s.to],
        ["amount", `${units(s.lamports, 9)} SOL (${s.lamports} lamports)`],
        ["fee", "~0.000005 SOL"],
        ["blockhash", st.prepared ? `${st.prepared.blockhash} (valid to block ${st.prepared.lastValidBlockHeight})` : "fetched right before signing"],
        ["signed by", `step ${Number(s.signedBy.slice(1))}`],
      ],
      actions: [], atomic: false, signedWith: "mpc",
      fee: st.feePaid ? `${units(BigInt(st.feePaid), 9)} SOL` : undefined,
    };
  });

  const txs = plan.steps.filter((s) => s.type !== "assert" && s.type !== "delegate-sign" && s.type !== "intents-wait");
  const nearFee = plan.steps.reduce((x, s) => x + (s.type === "near-tx" ? s.maxFee : 0n), 0n);
  const deposits = plan.steps.reduce((x, s) => x + (s.type === "near-tx" ? s.actions.reduce((y, a) => y + actionDeposit(a), 0n) : 0n), 0n);
  const evmFee = plan.steps.reduce((x, s) => x + (s.type === "evm-tx" || s.type === "evm-wallet-tx" ? s.maxFee : 0n), 0n);
  const btcFee = plan.steps.reduce((x, s) => x + (s.type === "btc-tx" ? s.fee : 0n), 0n);
  const risk = steps.reduce<Risk>((m, s) => (RANK.indexOf(s.risk[s.risk.length - 1]) > RANK.indexOf(m) ? s.risk[s.risk.length - 1] : m), "read-only");

  const simulated: string[] = [];
  const asserts = plan.steps.filter((s) => s.type === "assert").length;
  if (asserts) simulated.push(`${asserts} check(s) evaluated against live state`);
  if (plan.steps.some((s) => s.type === "near-tx")) simulated.push(`NEAR ${plan.network}: balances, accounts and gas price read`);
  for (const s of plan.steps) {
    if (s.type === "evm-wallet-tx") simulated.push(`${s.chain.label}: your wallet's transaction simulated from ${s.from.slice(0, 8)}…`);
  }
  for (const label of new Set(plan.steps.filter((s) => s.type === "evm-tx").map((s) => (s as any).chain.label))) {
    simulated.push(`${label}: nonce pinned, gas estimated by simulating each call`);
  }
  if (plan.steps.some((s) => s.type === "btc-tx")) simulated.push("Bitcoin: UTXOs selected, fee pinned, sighashes computed");
  if (plan.steps.some((s) => s.type === "sol-tx")) simulated.push("Solana: balances and rent exemption checked");
  for (const s of plan.steps) {
    if (s.type === "intents-wait") simulated.push(`NEAR Intents: live quote ${units(s.from.amount, s.from.decimals)} ${s.from.symbol} → ~${units(s.to.amountOut, s.to.decimals)} ${s.to.symbol}, deposit address reserved`);
  }
  simulated.push(`${plan.checks.length} funding/safety check(s): ${plan.checks.filter((c) => c.level === "fail").length} blocking`);

  return {
    hash: plan.scriptHash,
    account: plan.account,
    network: plan.network as PlanView["network"],
    steps,
    prints: plan.prints,
    checks: plan.checks,
    problems: planProblems(plan),
    txCount: txs.length,
    chainCount: new Set(txs.filter((s) => "chain" in s).map((s) => (s.type === "near-tx" ? "near" : (s as any).chain.label))).size,
    cost: [
      `NEAR fees up to ${near(nearFee)}`,
      `deposits ${near(deposits)}`,
      evmFee ? `EVM gas up to ${eth(evmFee).replace(/ ETH$/, "")} (native)` : "",
      btcFee ? `BTC fee ${btcFee} sats` : "",
    ].filter(Boolean).join(", "),
    walletTxCount: steps.filter((s) => s.signedWith === "wallet").length,
    risk,
    simulated,
  };
}
