import type { CmpOp, Expr } from "../lang/ast.js";

/** A non-integer number literal, kept exact until a command says what it means (e.g. token units). */
export interface Decimal {
  $decimal: { digits: bigint; exp: number };
}
export type Value = bigint | string | boolean | null | Decimal | Value[] | { [k: string]: Value };

export type Chain =
  | { kind: "near"; network: string }
  | { kind: "evm"; name: string; label: string; chainId: number; symbol: string }
  | { kind: "btc"; name: string; label: string; network: "mainnet" | "testnet" }
  | { kind: "sol"; name: string; label: string; cluster: "mainnet-beta" | "devnet" };

export type StepStatus = "planned" | "signed" | "broadcast" | "confirmed" | "failed";

export interface StepBase {
  id: string;
  index: number;
  source: { line: number; text: string };
  /** Plain-language line used by the preview, the executor log and the receipt. */
  description: string;
}

export type KeyPermission = "full" | { receiver: string; methods: string[]; allowance: bigint | null };

/** One NEAR protocol action. `decoded` is its human rendering. */
export type NearAction =
  | { kind: "call"; method: string; args: unknown; deposit: bigint; gas: bigint; decoded: string }
  | { kind: "transfer"; deposit: bigint; decoded: string }
  | { kind: "create-account"; decoded: string }
  | { kind: "delete-account"; beneficiary: string; decoded: string }
  | { kind: "add-key"; publicKey: string; permission: KeyPermission; decoded: string }
  | { kind: "delete-key"; publicKey: string; decoded: string }
  | { kind: "deploy"; codeBase64: string; sha256: string; size: number; decoded: string }
  | { kind: "deploy-global"; codeBase64: string; sha256: string; size: number; mode: "hash" | "account"; decoded: string }
  | { kind: "use-global"; ref: { hash: string } | { account: string }; decoded: string }
  | { kind: "stake"; amount: bigint; publicKey: string; decoded: string }
  /**
   * NEP-366 meta transaction: `sender` signs a DelegateAction (at execution time, with a fresh
   * nonce and expiry) and the transaction's signer relays it, paying gas and deposits.
   */
  | { kind: "delegate"; sender: string; receiver: string; actions: NearAction[]; decoded: string }
  /** Relay a DelegateAction someone else already signed (borsh, base64). */
  | { kind: "signed-delegate"; base64: string; sender: string; receiver: string; decoded: string };

/** Gas a transaction must attach for this action (only function calls attach gas). */
export const actionGas = (a: NearAction): bigint =>
  a.kind === "call" ? a.gas : a.kind === "delegate" ? a.actions.reduce((s, x) => s + actionGas(x), 0n) : 0n;
/** NEAR the transaction's signer pays on top of gas (deposits, transfers, stake is locked not paid). */
export const actionDeposit = (a: NearAction): bigint =>
  a.kind === "call" || a.kind === "transfer" ? a.deposit
    : a.kind === "delegate" ? a.actions.reduce((s, x) => s + actionDeposit(x), 0n)
    : 0n;

export interface NearTxStep extends StepBase {
  type: "near-tx";
  chain: Chain & { kind: "near" };
  /** The account that signs (the script's account, or the account named by an `as` block). */
  sender: string;
  /** Exactly one receiver: this is what makes the step atomic. */
  receiver: string;
  actions: NearAction[];
  /** True when the script asked for atomicity with `batch`, or a command needed it (storage_deposit + transfer). */
  atomic: boolean;
  /** Upper bound: attached gas x gas price. Unused gas is refunded. */
  maxFee: bigint;
  /**
   * mpc-sign: asks the MPC network to sign another step's transaction.
   * `late`: the payload is built right before signing (Solana: blockhashes expire in about a minute),
   * so the action args hold a placeholder until then.
   */
  purpose?: { kind: "mpc-sign"; forStep: string; path: string; payloadHex: string; scheme: "secp256k1" | "ed25519"; late?: boolean; input?: number };
  /** True when the action list deletes the signing account. */
  deletesSender?: boolean;
}

/** meta:sign: a NEP-366 SignedDelegate produced locally and NOT sent; the receipt shows it for a relayer. */
export interface DelegateSignStep extends StepBase {
  type: "delegate-sign";
  chain: Chain & { kind: "near" };
  sender: string;
  receiver: string;
  actions: NearAction[];
  /** Blocks the delegate stays valid for, from signing time. */
  ttlBlocks: number;
}

export interface EvmTxStep extends StepBase {
  type: "evm-tx";
  chain: Chain & { kind: "evm" };
  /** Address derived from (NEAR account, path) through Chain Signatures. */
  sender: `0x${string}`;
  derivation: { accountId: string; path: string };
  to: `0x${string}`;
  signature: string;
  args: unknown[];
  decoded: string;
  data: `0x${string}`;
  value: bigint;
  /** Pinned when the plan is frozen. The signed payload commits to it, so the step is idempotent. */
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  maxFee: bigint;
  /** id of the near-tx step that asks the MPC network to sign this transaction. */
  signedBy: string;
}

export interface AssertStep extends StepBase {
  type: "assert";
  /** preflight: before any transaction step, checked before anything is signed. gate: between steps. */
  phase: "preflight" | "gate";
  left: Expr;
  op: CmpOp;
  right: Expr;
  message?: string;
  /** Variables as they were at this point in the script; helpers are re-evaluated live. */
  vars: Record<string, Value>;
  modules: string[];
  /** Result at plan time (gates are evaluated again when the run reaches them). */
  planResult: { ok: boolean; detail: string };
}

/** Bitcoin P2WPKH payment from a Chain Signatures address. Inputs and fee are pinned at plan time. */
export interface BtcTxStep extends StepBase {
  type: "btc-tx";
  chain: Chain & { kind: "btc" };
  sender: string;
  /** Compressed secp256k1 public key (hex) of the derived address. */
  publicKey: string;
  derivation: { accountId: string; path: string };
  to: string;
  amount: bigint;
  fee: bigint;
  maxFee: bigint;
  inputs: { txid: string; vout: number; value: bigint }[];
  /** Unsigned PSBT (hex). The signatures commit to it. */
  psbtHex: string;
  /** One sighash per input, hex. */
  hashes: string[];
  /** One MPC sign step per input, in input order. */
  signedBy: string[];
}

/** Solana SOL transfer from a Chain Signatures address. Built and signed at execution time. */
export interface SolTxStep extends StepBase {
  type: "sol-tx";
  chain: Chain & { kind: "sol" };
  sender: string;
  derivation: { accountId: string; path: string };
  to: string;
  lamports: bigint;
  maxFee: bigint;
  signedBy: string;
}

/** NEAR Intents: wait for the solvers to deliver after the deposit step lands. Sends nothing. */
export interface IntentsWaitStep extends StepBase {
  type: "intents-wait";
  depositAddress: string;
  depositMemo?: string;
  /** Step that sends the deposit; its tx hash is submitted to 1Click to speed things up. */
  depositStep: string;
  from: { chain: string; label: string; symbol: string; assetId: string; amount: bigint; decimals: number; refundTo: string };
  to: { chain: string; label: string; symbol: string; assetId: string; amountOut: bigint; minAmountOut: bigint; decimals: number; recipient: string };
  deadline: string;
  timeEstimate: number;
  correlationId?: string;
}

export type Step = NearTxStep | EvmTxStep | BtcTxStep | SolTxStep | DelegateSignStep | IntentsWaitStep | AssertStep;

/** Automatic preflight checks (funding, balances). `warn` does not block a run. */
export interface Check {
  level: "ok" | "warn" | "fail";
  description: string;
}

export interface Plan {
  scriptHash: string;
  account: string;
  network: string;
  createdAt: string;
  steps: Step[];
  checks: Check[];
  prints: string[];
}

export interface StepState {
  status: StepStatus;
  /** near-tx: signed transaction (base64). evm-tx: signed raw transaction (hex). */
  signedPayload?: string;
  txHash?: string;
  /** near-tx only: what the signature committed to. */
  nonce?: string;
  /** near-tx only: the key that signed (to check its nonce on resume). Absent when a wallet signed. */
  publicKey?: string;
  blockHash?: string;
  result?: unknown;
  error?: string;
  feePaid?: string;
  attempts?: number;
  /** sol-tx: the message built for the current signing attempt (base64) and when it expires. */
  prepared?: { messageBase64: string; blockhash: string; lastValidBlockHeight: number };
  /** Wallet mode: the browser was asked to sign and send this step at this time; outcome not recorded yet. */
  handoff?: string;
}

export interface Checkpoint {
  version: 1;
  plan: Plan;
  state: Record<string, StepState>;
  log: { at: string; step: string; event: string }[];
}

export const isDecimal = (v: Value): v is Decimal =>
  typeof v === "object" && v !== null && !Array.isArray(v) && "$decimal" in v;

/** JSON codec that keeps bigints exact. */
export const encodeJson = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? { $bigint: x.toString() } : x), 2);
export const decodeJson = <T>(s: string): T =>
  JSON.parse(s, (_k, x) => (x && typeof x === "object" && typeof x.$bigint === "string" ? BigInt(x.$bigint) : x));
