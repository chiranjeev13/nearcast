import type { Step, StepState } from "../plan/types.js";

/**
 * What to do with a step given its persisted state. This is the whole resume policy, kept pure:
 *
 *   planned   -> start: evaluate an assert, or sign a transaction (the nonce is fixed at signing)
 *   signed    -> rebroadcast the SAME signed bytes (never sign again)
 *   broadcast -> poll for the outcome
 *   confirmed -> skip
 *   failed    -> retry only where that cannot double-execute; otherwise stop
 */
export type Action = "skip" | "evaluate" | "sign" | "rebroadcast" | "poll" | "retry" | "stop";

export function nextAction(step: Step, st: StepState, opts: { retryFailed?: boolean } = {}): Action {
  switch (st.status) {
    case "confirmed":
      return "skip";
    case "planned":
      return step.type === "assert" ? "evaluate" : "sign";
    case "signed":
      return "rebroadcast";
    case "broadcast":
      return "poll";
    case "failed":
      // A failed assert changed nothing: check it again.
      if (step.type === "assert") return "retry";
      // A failed MPC signature request has no effect besides its fee, so asking again is safe.
      if (step.type === "near-tx" && step.purpose?.kind === "mpc-sign") return "retry";
      // Any other failed NEAR transaction is retried only on request: later receipts may have had effects.
      if (step.type === "near-tx") return opts.retryFailed ? "retry" : "stop";
      // A wallet transaction that failed: retry only on request (a rejected one sent nothing; a reverted one did).
      if (step.type === "evm-wallet-tx") return opts.retryFailed ? "retry" : "stop";
      // Producing a signed delegate sends nothing: safe to do again.
      if (step.type === "delegate-sign") return "retry";
      // A reverted EVM transaction consumed its pinned nonce; a rejected Bitcoin or Solana
      // transaction needs a human to look first.
      return "stop";
  }
}

/**
 * A NEAR transaction we signed is unknown to the network. May we sign a replacement?
 * Only when the old one provably never landed and never can.
 */
export function unseenNearTx(landing: "possible" | "impossible" | "ambiguous"): "wait" | "resign" | "needs-human" {
  if (landing === "impossible") return "resign";
  if (landing === "ambiguous") return "needs-human";
  return "wait";
}

const ORDER = ["planned", "signed", "broadcast", "confirmed"] as const;

/** Legal status moves. Forward one stage at a time; `failed` from anywhere in flight; reset only via the rules above. */
export function canMove(from: StepState["status"], to: StepState["status"], via?: "wallet"): boolean {
  if (to === "failed") return from !== "confirmed";
  // A wallet signs and sends in one go: the first thing we learn is the hash of a sent transaction.
  if (via === "wallet") return from === "planned" && to === "broadcast";
  if (from === "failed") return to === "planned";
  if (to === "planned") return from === "signed" || from === "broadcast"; // provably-dead transaction
  return ORDER.indexOf(to) === ORDER.indexOf(from) + 1;
}
