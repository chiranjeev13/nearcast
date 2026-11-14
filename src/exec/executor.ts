import type { Env } from "../env.js";
import { finalize, type MpcSignature } from "../evm/tx.js";
import { MODULES } from "../modules/index.js";
import { evalAssert } from "../plan/eval.js";
import type {
  AssertStep,
  BtcTxStep,
  Checkpoint,
  EvmTxStep,
  EvmWalletTxStep,
  IntentsWaitStep,
  NearAction,
  NearTxStep,
  SolTxStep,
  Step,
  StepState,
  StepStatus,
} from "../plan/types.js";
import type { Store } from "./store.js";
import { canMove, nextAction, unseenNearTx } from "./machine.js";

export type WalletResult = { txHash: string } | { error: string };

export interface ExecOptions {
  log?: (msg: string) => void;
  pollMs?: number;
  /** Give up waiting on one step after this long. The step stays resumable. */
  timeoutMs?: number;
  /** Polls with the transaction unknown before asking whether it can still land. */
  unknownGrace?: number;
  retryFailed?: boolean;
  /** Called after every persisted status change. Tests and --kill-at use it to die at an exact point. */
  afterPersist?: (step: Step, status: StepStatus) => void;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Wallet mode: have the connected wallet sign and send a NEAR transaction for an account with no
   * local key. Resolves with the sent transaction's hash, or an error when nothing was sent.
   */
  wallet?: (step: NearTxStep, actions: NearAction[]) => Promise<WalletResult>;
  /** The browser's EVM wallet (MetaMask) signs and sends an `evm-wallet-tx` step from the user's address. */
  evmWallet?: (step: EvmWalletTxStep) => Promise<WalletResult>;
}

export type Outcome =
  | { kind: "done" }
  | { kind: "failed"; step: Step; error: string }
  | { kind: "waiting"; step: Step; reason: string; handoff?: boolean };

const MAX_SIGN_ATTEMPTS = 3;

/** The MPC network's ECDSA answer as 64-byte r||s hex (Bitcoin wants it this way). */
function rs(sig: MpcSignature): string {
  if (!sig?.big_r?.affine_point || !sig?.s?.scalar) throw new Error(`unexpected MPC signature shape: ${JSON.stringify(sig)}`);
  return sig.big_r.affine_point.slice(2).padStart(64, "0") + sig.s.scalar.padStart(64, "0");
}

/** The MPC network's EdDSA answer: { scheme: "Ed25519", signature: number[64] }. */
function ed(sig: any): Uint8Array {
  const bytes = sig?.signature;
  if (!Array.isArray(bytes) || bytes.length !== 64) throw new Error(`unexpected MPC ed25519 signature shape: ${JSON.stringify(sig)}`);
  return Uint8Array.from(bytes);
}

/** Sign-request actions with a late payload filled in. */
function withPayload(actions: NearAction[], payloadHex: string): NearAction[] {
  return actions.map((a) => {
    if (a.kind !== "call" || a.method !== "sign") return a;
    const req = (a.args as any).request;
    const key = Object.keys(req.payload_v2)[0];
    return { ...a, args: { request: { ...req, payload_v2: { [key]: payloadHex } } } };
  });
}

/**
 * Walk the frozen plan in order. Every status change is written to the checkpoint before the next
 * side effect, so the run can be killed at any point and resumed from the file alone.
 */
export async function execute(cp: Checkpoint, env: Env, store: Store, opts: ExecOptions = {}): Promise<Outcome> {
  const log = opts.log ?? (() => {});
  const pollMs = opts.pollMs ?? 1500;
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const grace = opts.unknownGrace ?? 10;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const steps = cp.plan.steps;
  const byId = new Map(steps.map((s) => [s.id, s]));

  const persist = (step: Step, status: StepStatus, event: string) => {
    cp.log.push({ at: new Date().toISOString(), step: step.id, event });
    store.save(cp);
    opts.afterPersist?.(step, status);
  };
  const move = (step: Step, patch: Partial<StepState> & { status: StepStatus }, via?: "wallet") => {
    const prev = cp.state[step.id] ?? { status: "planned" as const };
    if (prev.status !== patch.status && !canMove(prev.status, patch.status, via)) {
      throw new Error(`internal: illegal move ${prev.status} -> ${patch.status} for step ${step.index + 1}`);
    }
    cp.state[step.id] = patch.status === "planned" ? { status: "planned", attempts: prev.attempts } : { ...prev, ...patch };
    persist(step, patch.status, patch.status + (patch.error ? `: ${patch.error}` : ""));
  };
  /** Change fields of a step without changing its status (still persisted before the next side effect). */
  const note = (step: Step, patch: Partial<StepState>, event: string) => {
    cp.state[step.id] = { ...(cp.state[step.id] ?? { status: "planned" }), ...patch };
    persist(step, cp.state[step.id].status, event);
  };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const n = step.index + 1;
    for (;;) {
      const st = cp.state[step.id] ?? { status: "planned" as const };
      const action = nextAction(step, st, opts);
      if (action === "skip") break;
      if (action === "stop") return { kind: "failed", step, error: st.error ?? "failed" };
      if (action === "retry") {
        if (step.type === "near-tx" && step.purpose && (st.attempts ?? 0) >= MAX_SIGN_ATTEMPTS) {
          return { kind: "failed", step, error: `${st.error} (after ${st.attempts} attempts)` };
        }
        log(`step ${n}: retrying after failure (${st.error})`);
        move(step, { status: "planned" });
        continue;
      }

      if (step.type === "assert") {
        const r = await runAssert(step, env);
        if (r.ok) {
          log(`step ${n}: check passed (${r.detail})`);
          cp.state[step.id] = { status: "confirmed", result: `${r.detail} is true` };
          persist(step, "confirmed", "confirmed");
          break;
        }
        const error = `${step.message ?? "assertion failed"}: ${r.detail} is false`;
        move(step, { status: "failed", error });
        return { kind: "failed", step, error };
      }

      if (step.type === "delegate-sign") {
        try {
          const d = await env.near.signDelegate(step.sender, step.receiver, step.actions, step.ttlBlocks);
          cp.state[step.id] = { status: "confirmed", result: { signedDelegate: d.base64, validUntilBlock: d.maxBlockHeight.toString() } };
          persist(step, "confirmed", "confirmed");
          log(`step ${n}: signed meta transaction (valid until block ${d.maxBlockHeight}); not sent`);
          break;
        } catch (e) {
          const error = (e as Error).message;
          move(step, { status: "failed", error });
          return { kind: "failed", step, error };
        }
      }

      if (step.type === "intents-wait") {
        // Twice the transaction poll interval: 1Click is an HTTP API shared by everyone.
        const r = await waitIntents(step, cp, env, { pollMs: pollMs * 2, timeoutMs, sleep }, log, n);
        if (r.kind === "confirmed") {
          cp.state[step.id] = { status: "confirmed", result: r.result };
          persist(step, "confirmed", "confirmed");
          log(`step ${n}: NEAR Intents delivered`);
          break;
        }
        if (r.kind === "failed") {
          move(step, { status: "failed", error: r.error, result: r.result });
          return { kind: "failed", step, error: r.error };
        }
        return { kind: "waiting", step, reason: r.reason };
      }

      if (step.type === "evm-wallet-tx" && action === "sign") {
        if (st.handoff) {
          return {
            kind: "waiting", step, handoff: true,
            reason: `your EVM wallet was asked to send step ${n} at ${st.handoff} but its answer was never recorded. ` +
              "Check the wallet's activity: give the transaction hash if it was sent, or confirm it was not.",
          };
        }
        if (!opts.evmWallet) return { kind: "failed", step, error: "this step is sent by your EVM wallet (MetaMask): run it from the web UI" };
        note(step, { handoff: new Date().toISOString(), attempts: (st.attempts ?? 0) + 1 }, "handed to EVM wallet");
        log(`step ${n}: waiting for your wallet to send it on ${step.chain.label}`);
        const r = await opts.evmWallet(step);
        if ("txHash" in r) {
          move(step, { status: "broadcast", txHash: r.txHash, handoff: undefined, error: undefined }, "wallet");
          log(`step ${n}: wallet sent ${r.txHash}`);
        } else {
          move(step, { status: "failed", error: `wallet: ${r.error} (nothing was sent)`, handoff: undefined });
          return { kind: "failed", step, error: `wallet: ${r.error} (nothing was sent)` };
        }
        continue;
      }

      if (action === "sign") {
        if (step.type === "near-tx") {
          let actions = step.actions;
          if (step.purpose?.late) {
            const target = byId.get(step.purpose.forStep) as SolTxStep;
            const prepared = await env.sol.prepare(target);
            const payloadHex = Buffer.from(prepared.messageBase64, "base64").toString("hex");
            // Persist the message before asking for its signature: the signature is only useful with it.
            note(target, { prepared }, `prepared message (blockhash ${prepared.blockhash})`);
            actions = withPayload(actions, payloadHex);
            log(`step ${n}: built ${target.chain.label} message with a fresh blockhash`);
          }
          if (env.near.canSign(step.sender)) {
            const tx = await env.near.signTx(step.sender, step.receiver, actions);
            // Persist the signed bytes and hash BEFORE sending. From here on this step has exactly one identity.
            move(step, {
              status: "signed", signedPayload: tx.base64, txHash: tx.hash, nonce: tx.nonce.toString(), blockHash: tx.blockHash,
              publicKey: tx.publicKey, attempts: (st.attempts ?? 0) + 1, error: undefined,
            });
            log(`step ${n}: signed NEAR transaction ${tx.hash} (nonce ${tx.nonce})`);
            continue;
          }
          // No local key: the connected wallet signs and sends.
          if (st.handoff) {
            return {
              kind: "waiting", step, handoff: true,
              reason: `the wallet was asked to sign step ${n} at ${st.handoff} but its answer was never recorded. ` +
                "Check the wallet or an explorer: give the transaction hash if it was sent, or confirm it was not.",
            };
          }
          if (!opts.wallet) return { kind: "failed", step, error: `no local key for ${step.sender} and no wallet connected` };
          note(step, { handoff: new Date().toISOString(), attempts: (st.attempts ?? 0) + 1 }, "handed to wallet");
          log(`step ${n}: waiting for the wallet to sign and send`);
          const r = await opts.wallet(step, actions);
          if ("txHash" in r) {
            move(step, { status: "broadcast", txHash: r.txHash, handoff: undefined, error: undefined }, "wallet");
            log(`step ${n}: wallet sent ${r.txHash}`);
          } else {
            move(step, { status: "failed", error: `wallet: ${r.error} (nothing was sent)`, handoff: undefined });
            return { kind: "failed", step, error: `wallet: ${r.error} (nothing was sent)` };
          }
          continue;
        }
        let signed: { raw: string; hash: string };
        try {
          if (step.type === "evm-wallet-tx") throw new Error("internal: wallet steps are never assembled");
        signed = await assemble(step as EvmTxStep | BtcTxStep | SolTxStep, cp, env);
        } catch (e) {
          const error = (e as Error).message;
          if (/^no MPC signature yet/.test(error)) return { kind: "failed", step, error };
          move(step, { status: "failed", error });
          return { kind: "failed", step, error };
        }
        move(step, { status: "signed", signedPayload: signed.raw, txHash: signed.hash });
        log(`step ${n}: assembled signed ${(step as EvmTxStep).chain.label} transaction ${signed.hash}`);
        continue;
      }

      if (action === "rebroadcast") {
        const raw = st.signedPayload!;
        if (step.type === "near-tx") await env.near.broadcast(raw);
        else if (step.type === "evm-tx") await env.evm.send(step.chain, raw as `0x${string}`);
        else if (step.type === "btc-tx") await env.btc.send(step.chain, raw);
        else if (step.type === "sol-tx") await env.sol.send(step.chain, raw);
        move(step, { status: "broadcast" });
        log(`step ${n}: sent ${st.txHash}`);
        continue;
      }

      // action === "poll"
      const o = { pollMs, timeoutMs, grace, sleep };
      const r = step.type === "near-tx" ? await pollNear(step, st, env, o)
        : step.type === "evm-tx" ? await pollEvm(step, st, env, o)
        : step.type === "evm-wallet-tx" ? await pollEvmWallet(step, st, env, o)
        : step.type === "btc-tx" ? await pollBtc(step, st, env, o)
        : await pollSol(step as SolTxStep, st, env, o);
      if (r.kind === "confirmed") {
        move(step, { status: "confirmed", result: r.result, feePaid: r.feePaid?.toString() });
        log(`step ${n}: confirmed`);
        break;
      }
      if (r.kind === "failed") {
        move(step, { status: "failed", error: r.error, feePaid: r.feePaid?.toString() });
        if (nextAction(step, cp.state[step.id], opts) === "retry") continue;
        return { kind: "failed", step, error: r.error };
      }
      if (r.kind === "resign") {
        log(`step ${n}: transaction ${st.txHash} expired without landing; signing a replacement`);
        move(step, { status: "planned" });
        continue;
      }
      if (r.kind === "rewind") {
        // Solana: the signed transaction can never land (its blockhash expired). Its signature is
        // worthless, so ask the MPC network again for a fresh message.
        const signStep = byId.get((step as SolTxStep).signedBy)!;
        log(`step ${n}: ${st.txHash} expired without landing; rebuilding it and asking for a new signature (step ${signStep.index + 1})`);
        move(step, { status: "planned" });
        cp.state[signStep.id] = { status: "planned", attempts: cp.state[signStep.id]?.attempts };
        persist(signStep, "planned", "planned: its transaction expired unsent");
        i = signStep.index - 1;
        break;
      }
      return { kind: "waiting", step, reason: r.reason };
    }
  }
  return { kind: "done" };
}

/** Attach MPC signatures to a foreign-chain step. Each chain's finalize verifies before anything can be broadcast. */
async function assemble(step: EvmTxStep | BtcTxStep | SolTxStep, cp: Checkpoint, env: Env): Promise<{ raw: string; hash: string }> {
  const sigOf = (id: string): any => {
    const s = cp.state[id];
    if (s?.status !== "confirmed" || !s.result) throw new Error(`no MPC signature yet from step ${Number(id.slice(1))}`);
    return s.result;
  };
  if (step.type === "evm-tx") return finalize(step, sigOf(step.signedBy) as MpcSignature);
  if (step.type === "btc-tx") {
    const { raw, txid } = env.btc.finalize(step, step.signedBy.map((id) => rs(sigOf(id))));
    return { raw, hash: txid };
  }
  const prepared = cp.state[step.id]?.prepared;
  if (!prepared) throw new Error(`no prepared message for step ${step.index + 1}; its signature cannot be used`);
  const { raw, txid } = env.sol.finalize(step, prepared.messageBase64, ed(sigOf(step.signedBy)));
  return { raw, hash: txid };
}

/** Poll NEAR Intents until the swap settles. Only the outcome is recorded; nothing is signed here. */
async function waitIntents(
  step: IntentsWaitStep,
  cp: Checkpoint,
  env: Env,
  o: { pollMs: number; timeoutMs: number; sleep: (ms: number) => Promise<void> },
  log: (m: string) => void,
  n: number,
): Promise<{ kind: "confirmed"; result: unknown } | { kind: "failed"; error: string; result?: unknown } | { kind: "waiting"; reason: string }> {
  const dep = cp.state[step.depositStep];
  if (dep?.status !== "confirmed") return { kind: "waiting", reason: `deposit step ${Number(step.depositStep.slice(1))} is not confirmed yet` };
  if (dep.txHash) await env.intents.submit(dep.txHash, step.depositAddress, step.depositMemo);
  let last = "";
  for (let waited = 0; waited <= o.timeoutMs; waited += o.pollMs) {
    const s = await env.intents.status(step.depositAddress, step.depositMemo);
    if (s.status !== last) {
      log(`step ${n}: NEAR Intents status ${s.status}`);
      last = s.status;
    }
    const d = s.swapDetails ?? {};
    const result = {
      status: s.status,
      amountOut: d.amountOut,
      amountOutFormatted: d.amountOutFormatted,
      destinationTxs: (d.destinationChainTxHashes ?? []).map((x: any) => x.explorerUrl || x.hash || x),
      refundedAmount: d.refundedAmountFormatted,
    };
    if (s.status === "SUCCESS") return { kind: "confirmed", result };
    if (s.status === "REFUNDED") {
      return { kind: "failed", result, error: `refunded to ${step.from.refundTo}${d.refundedAmountFormatted ? ` (${d.refundedAmountFormatted} ${step.from.symbol})` : ""}: ${d.refundReason ?? "the swap could not be filled"}` };
    }
    if (s.status === "FAILED") return { kind: "failed", result, error: "NEAR Intents reports the swap FAILED" };
    if (s.status === "INCOMPLETE_DEPOSIT") return { kind: "failed", result, error: "the deposit was smaller than the quote required" };
    await o.sleep(o.pollMs);
  }
  return { kind: "waiting", reason: `NEAR Intents is still ${last || "processing"} (quoted ~${step.timeEstimate}s); resume to keep waiting` };
}

async function runAssert(step: AssertStep, env: Env): Promise<{ ok: boolean; detail: string }> {
  return evalAssert(
    {
      env,
      vars: new Map(Object.entries(step.vars)),
      modules: new Map(step.modules.map((m) => [m, MODULES[m]])),
    },
    step,
  );
}

type PollResult =
  | { kind: "confirmed"; result?: unknown; feePaid?: bigint }
  | { kind: "failed"; error: string; feePaid?: bigint }
  | { kind: "resign" }
  | { kind: "rewind" }
  | { kind: "waiting"; reason: string };

interface PollOpts {
  pollMs: number;
  timeoutMs: number;
  grace: number;
  sleep: (ms: number) => Promise<void>;
}

async function pollNear(step: NearTxStep, st: StepState, env: Env, o: PollOpts): Promise<PollResult> {
  let unknown = 0;
  for (let waited = 0; waited <= o.timeoutMs; waited += o.pollMs) {
    const out = await env.near.status(st.txHash!, step.sender);
    if (out.state === "success") return { kind: "confirmed", result: out.value, feePaid: out.tokensBurnt };
    if (out.state === "failure") return { kind: "failed", error: nearError(out.error), feePaid: out.tokensBurnt };
    // A wallet-sent transaction has no stored bytes or nonce: we can only wait for it.
    if (out.state === "unknown" && st.signedPayload && ++unknown >= o.grace) {
      const verdict = unseenNearTx(await env.near.landing(step.sender, st.publicKey ?? "", st.blockHash!, BigInt(st.nonce!)));
      if (verdict === "resign") return { kind: "resign" };
      if (verdict === "needs-human") {
        return {
          kind: "waiting",
          reason: `NEAR transaction ${st.txHash} is unknown to the RPC but its nonce has been used. ` +
            "It may have landed (check an explorer) or another transaction took the nonce. Not re-signing, to avoid sending twice.",
        };
      }
      unknown = 0;
      await env.near.broadcast(st.signedPayload!); // same bytes, harmless
    }
    await o.sleep(o.pollMs);
  }
  return { kind: "waiting", reason: `NEAR transaction ${st.txHash} has not finished yet` };
}

async function pollEvm(step: EvmTxStep, st: StepState, env: Env, o: PollOpts): Promise<PollResult> {
  let polls = 0;
  for (let waited = 0; waited <= o.timeoutMs; waited += o.pollMs) {
    const r = await env.evm.receipt(step.chain, st.txHash as `0x${string}`);
    if (r.state === "success") return { kind: "confirmed", feePaid: r.feePaid };
    if (r.state === "reverted") {
      return {
        kind: "failed",
        feePaid: r.feePaid,
        error: `reverted on ${step.chain.label}. Gas was spent and nonce ${step.nonce} is used. Earlier steps are NOT undone.`,
      };
    }
    if (++polls % 10 === 0) await env.evm.send(step.chain, st.signedPayload as `0x${string}`); // same bytes, harmless
    await o.sleep(o.pollMs);
  }
  return { kind: "waiting", reason: `${step.chain.label} transaction ${st.txHash} is not mined yet (fee cap may be below the current base fee)` };
}

async function pollEvmWallet(step: EvmWalletTxStep, st: StepState, env: Env, o: PollOpts): Promise<PollResult> {
  for (let waited = 0; waited <= o.timeoutMs; waited += o.pollMs) {
    const r = await env.evm.receipt(step.chain, st.txHash as `0x${string}`);
    if (r.state === "success") return { kind: "confirmed", feePaid: r.feePaid };
    if (r.state === "reverted") return { kind: "failed", feePaid: r.feePaid, error: `reverted on ${step.chain.label}; gas was spent. Earlier steps are NOT undone.` };
    await o.sleep(o.pollMs);
  }
  return { kind: "waiting", reason: `${step.chain.label} transaction ${st.txHash} from your wallet is not mined yet` };
}

async function pollBtc(step: BtcTxStep, st: StepState, env: Env, o: PollOpts): Promise<PollResult> {
  let polls = 0;
  let seen = false;
  for (let waited = 0; waited <= o.timeoutMs; waited += o.pollMs) {
    const r = await env.btc.status(step.chain, st.txHash!);
    if (r === "confirmed") return { kind: "confirmed", feePaid: step.fee };
    if (r === "mempool") seen = true;
    if (r === "unknown" && ++polls % 10 === 0) await env.btc.send(step.chain, st.signedPayload!);
    await o.sleep(o.pollMs);
  }
  return {
    kind: "waiting",
    reason: seen
      ? `${step.chain.label} transaction ${st.txHash} is in the mempool, not yet in a block (blocks take ~10 minutes)`
      : `${step.chain.label} transaction ${st.txHash} is not visible yet`,
  };
}

async function pollSol(step: SolTxStep, st: StepState, env: Env, o: PollOpts): Promise<PollResult> {
  const lastValid = cp_prepared(st)?.lastValidBlockHeight ?? 0;
  let polls = 0;
  for (let waited = 0; waited <= o.timeoutMs; waited += o.pollMs) {
    const r = await env.sol.status(step.chain, st.txHash!, lastValid);
    if (r.state === "success") return { kind: "confirmed", feePaid: r.fee };
    if (r.state === "failed") return { kind: "failed", error: `failed on ${step.chain.label}: ${r.error}`, feePaid: r.fee };
    if (r.state === "expired") return { kind: "rewind" };
    if (++polls % 5 === 0) await env.sol.send(step.chain, st.signedPayload!);
    await o.sleep(o.pollMs);
  }
  return { kind: "waiting", reason: `${step.chain.label} transaction ${st.txHash} is not confirmed yet` };
}

const cp_prepared = (st: StepState) => st.prepared;

function nearError(raw?: string): string {
  if (!raw) return "transaction failed";
  const m = /"ExecutionError":"([^"]+)"/.exec(raw);
  if (m) return m[1];
  if (/LackBalanceForState|NotEnoughBalance/.test(raw)) return `not enough NEAR balance (${raw})`;
  return raw;
}
