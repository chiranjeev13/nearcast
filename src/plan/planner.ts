import type { BtcChain, Env, EvmChain, SolChain } from "./../env.js";
import { eth, near, tgas, units } from "../format.js";
import type { CommandStmt, Expr, Stmt } from "../lang/ast.js";
import { ScriptError } from "../lang/ast.js";
import { parse } from "../lang/parser.js";
import { MODULES } from "../modules/index.js";
import type { Module } from "../modules/types.js";
import { TGAS } from "../registry.js";
import { signingHash } from "../evm/tx.js";
import { envVar, sha256Hex } from "../portable.js";
import { evalAssert, evalExpr, show, type EvalCtx } from "./eval.js";
import {
  actionDeposit,
  actionGas,
  type BtcTxStep,
  type Check,
  type DelegateSignStep,
  type EvmTxStep,
  type EvmWalletTxStep,
  type NearAction,
  type NearTxStep,
  type Plan,
  type SignRequest,
  type SolTxStep,
  type Step,
  type Value,
} from "./types.js";

type StepBaseFields = { id: string; index: number; source: { line: number; text: string }; description: string };

type Scope =
  | { kind: "seq" }
  /** The receiver is given (`batch <receiver>`) or fixed by the first action (`batch ( ... )`). */
  | { kind: "batch"; receiver?: string; actions: NearAction[]; parts: string[]; after: ((txStepId: string) => void)[]; signs: SignRequest[] }
  | { kind: "evm" }
  /** meta:relay / meta:sign: like a batch, but the receiver is fixed by the first action. */
  | { kind: "meta"; receiver?: string; actions: NearAction[]; parts: string[] };

export const SIGN_GAS = BigInt(envVar("NEARCAST_SIGN_GAS_TGAS") ?? 50) * TGAS;
export const SIGN_DEPOSIT = BigInt(envVar("NEARCAST_SIGN_DEPOSIT_YOCTO") ?? 1);
/** Protocol limit on gas attached to one transaction (1 PGas). */
const MAX_TX_GAS = 1000n * TGAS;
const FALLBACK_EVM_GAS = 200_000n;
/** Storage staking: 10^19 yoctoNEAR per byte. */
const STORAGE_PRICE_PER_BYTE = 10n ** 19n;
/** Sending + executing a transaction, before any action: a generous upper bound. */
const TX_BASE_GAS = 5n * TGAS;

/** Protocol fees for actions that attach no gas (send + exec, rounded up). */
function staticGas(a: NearAction): bigint {
  switch (a.kind) {
    case "call":
      return 3n * TGAS; // function call base + per-byte, on top of attached gas
    case "deploy":
    case "deploy-global":
      // ~0.37 Tgas base + ~70 Mgas per byte (deploy_contract_cost_per_byte, send + exec)
      return TGAS + BigInt(a.size) * 75_000_000n * (a.kind === "deploy-global" ? 10n : 1n);
    case "delegate":
      return TGAS + a.actions.reduce((s, x) => s + staticGas(x), 0n);
    default:
      return TGAS;
  }
}

export interface NearOp {
  receiver: string;
  actions: NearAction[];
  description: string;
  atomic?: boolean;
  /** Warning the UI shows in red. */
  danger?: string;
}

export interface EvmOp {
  to: `0x${string}`;
  signature: string;
  args: unknown[];
  decoded: string;
  data: `0x${string}`;
  value: bigint;
  gas?: bigint;
  description: string;
}

export interface Derived {
  chain: EvmChain;
  path: string;
  sender: `0x${string}`;
}

export class PlanCtx implements EvalCtx {
  readonly vars = new Map<string, Value>();
  readonly modules = new Map<string, Module>([["std", MODULES.std]]);
  readonly steps: Step[] = [];
  readonly checks: Check[] = [];
  readonly prints: string[] = [];
  evm?: Derived;

  #scope: Scope = { kind: "seq" };
  /** The batch being built, also while inside chainsig:on within it. */
  #openBatch?: Extract<Scope, { kind: "batch" }>;
  #sender: string;
  #stmt!: Stmt;
  #txSeen = false;
  #gasPrice?: bigint;
  #evmNonce = new Map<string, number>();
  #evmFees = new Map<number, { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>();
  #deleted = new Set<string>();
  #btcFrom = new Set<string>();
  /** Extra NEAR each signer must hold that is not a fee or deposit (stake, contract storage). */
  #locked = new Map<string, bigint>();
  /** Accounts this plan creates: they cannot be checked on chain yet. */
  readonly created = new Set<string>();

  constructor(readonly env: Env) {
    this.#sender = env.near.accountId;
  }

  eval(e: Expr): Promise<Value> {
    return evalExpr(this, e);
  }
  get scopeKind(): Scope["kind"] {
    return this.#scope.kind;
  }
  /** The account that signs NEAR transactions at this point of the script. */
  get sender(): string {
    return this.#sender;
  }
  get line(): number {
    return this.#stmt.loc.line;
  }
  lock(account: string, amount: bigint): void {
    this.#locked.set(account, (this.#locked.get(account) ?? 0n) + amount);
  }
  #err(msg: string): ScriptError {
    return new ScriptError(msg, this.#stmt.loc);
  }

  #base(description: string, index = this.steps.length) {
    return {
      id: `s${index + 1}`,
      index,
      source: { line: this.#stmt.loc.line, text: this.#stmt.text },
      description,
    };
  }

  /** Called by commands that act on NEAR. Where the actions land depends on the enclosing block. */
  async near(op: NearOp): Promise<void> {
    const scope = this.#scope;
    if (scope.kind === "evm") {
      throw this.#err("NEAR commands are not allowed inside chainsig:on (...); only exec runs there");
    }
    if (scope.kind === "batch" || scope.kind === "meta") {
      scope.receiver ??= op.receiver;
      if (op.receiver !== scope.receiver) {
        const what = scope.kind === "batch" ? `batch ${scope.receiver}` : `this meta transaction (to ${scope.receiver})`;
        throw this.#err(
          `${what} cannot contain an action on ${op.receiver}. ` +
            "A NEAR transaction is atomic only when every action goes to one receiver. " +
            "Move this line out of the block, or use seq ( ... ) if it does not need to be atomic.",
        );
      }
      scope.actions.push(...op.actions);
      scope.parts.push(op.description);
      return;
    }
    await this.#emitNear(this.#sender, op.receiver, op.actions, op.description, op.atomic ?? op.actions.length > 1, undefined, op.danger);
  }

  async #emitNear(
    sender: string,
    receiver: string,
    actions: NearAction[],
    description: string,
    atomic: boolean,
    purpose?: NearTxStep["purpose"],
    danger?: string,
    index = this.steps.length,
  ): Promise<NearTxStep> {
    if (this.#deleted.has(sender)) {
      throw this.#err(`${sender} is deleted by an earlier step, so it cannot sign anything after that`);
    }
    const attached = actions.reduce((s, a) => s + actionGas(a), 0n);
    if (attached > MAX_TX_GAS) {
      throw this.#err(`transaction to ${receiver} attaches ${tgas(attached)}, over the ${tgas(MAX_TX_GAS)} per-transaction limit; split it`);
    }
    const deletesSender = receiver === sender && actions.some((a) => a.kind === "delete-account");
    if (actions.some((a) => a.kind === "delete-account") && actions[actions.length - 1].kind !== "delete-account") {
      throw this.#err("delete-account must be the last action of its transaction");
    }
    this.#gasPrice ??= await this.env.near.gasPrice();
    const gas = attached + TX_BASE_GAS + actions.reduce((s, a) => s + staticGas(a), 0n);
    const step: NearTxStep = {
      ...this.#base(description, index),
      type: "near-tx",
      chain: { kind: "near", network: this.env.near.network },
      sender,
      receiver,
      actions,
      atomic,
      maxFee: gas * this.#gasPrice,
      purpose,
      deletesSender: deletesSender || undefined,
    };
    if (danger) (step as NearTxStep & { danger?: string }).danger = danger;
    this.steps.splice(index, 0, step);
    this.#txSeen = true;
    if (deletesSender) this.#deleted.add(sender);
    return step;
  }

  // ------------------------------------------------------------------ chain signatures

  async #emitSign(forStep: string, path: string, payloadHex: string, scheme: "secp256k1" | "ed25519", what: string, extra: { late?: boolean; input?: number } = {}) {
    const domain = scheme === "secp256k1" ? 0 : 1;
    const key = scheme === "secp256k1" ? "Ecdsa" : "Eddsa";
    return this.#emitNear(
      this.#sender,
      this.env.near.signerContract,
      [{
        kind: "call",
        method: "sign",
        args: { request: { payload_v2: { [key]: payloadHex }, path, domain_id: domain } },
        deposit: SIGN_DEPOSIT,
        gas: SIGN_GAS,
        decoded: extra.late
          ? `sign the ${what} with key path "${path}" (${scheme}); payload built right before signing`
          : `sign payload 0x${payloadHex} with key path "${path}" (${scheme})`,
      }],
      `ask the MPC network to sign ${what}`,
      false,
      { kind: "mpc-sign", forStep, path, payloadHex, scheme, ...extra },
    );
  }

  /**
   * Inside batch ( ... ): add the sign request to the batch's transaction. Its `forStep` is filled in
   * once the foreign step exists (after the batch's transaction is built).
   */
  #queueSign(path: string, payloadHex: string, scheme: "secp256k1" | "ed25519", what: string, extra: { late?: boolean; input?: number } = {}): SignRequest {
    const b = this.#openBatch!;
    const signer = this.env.near.signerContract;
    b.receiver ??= signer;
    if (b.receiver !== signer) {
      throw this.#err(`this batch already goes to ${b.receiver}; chain signatures go to ${signer}. Put chainsig commands in their own batch ( ... ).`);
    }
    const domain = scheme === "secp256k1" ? 0 : 1;
    const key = scheme === "secp256k1" ? "Ecdsa" : "Eddsa";
    b.actions.push({
      kind: "call",
      method: "sign",
      args: { request: { payload_v2: { [key]: payloadHex }, path, domain_id: domain } },
      deposit: SIGN_DEPOSIT,
      gas: SIGN_GAS,
      decoded: extra.late
        ? `sign the ${what} with key path "${path}" (${scheme}); payload built right before signing`
        : `sign the ${what}: payload 0x${payloadHex} with key path "${path}" (${scheme})`,
    });
    b.parts.push(what);
    const req: SignRequest = { kind: "mpc-sign", forStep: "", path, payloadHex, scheme, ...extra };
    b.signs.push(req);
    return req;
  }

  /** One EVM call becomes two steps: the MPC signature request on NEAR, then the EVM broadcast. */
  async evmCall(op: EvmOp, from?: Derived): Promise<void> {
    const src = from ?? this.evm;
    if (!src) throw this.#err('exec is only valid inside chainsig:on <chain> "<path>" ( ... )');
    if (this.#scope.kind === "meta" || (this.#scope.kind === "batch" && !this.#openBatch)) {
      throw this.#err("a transaction on another chain cannot be part of a meta transaction");
    }
    const { chain, path, sender } = src;
    const key = `${chain.chainId}:${sender.toLowerCase()}`;
    if (!this.#evmNonce.has(key)) this.#evmNonce.set(key, await this.env.evm.nonce(chain, sender));
    const nonce = this.#evmNonce.get(key)!;
    this.#evmNonce.set(key, nonce + 1);
    if (!this.#evmFees.has(chain.chainId)) this.#evmFees.set(chain.chainId, await this.env.evm.fees(chain));
    const fees = this.#evmFees.get(chain.chainId)!;

    let gas = op.gas;
    if (gas === undefined) {
      const est = await this.env.evm.estimateGas(chain, { from: sender, to: op.to, data: op.data, value: op.value });
      if ("gas" in est) gas = (est.gas * 13n) / 10n;
      else {
        gas = FALLBACK_EVM_GAS;
        this.checks.push({
          level: "warn",
          description: `line ${this.#stmt.loc.line}: ${op.decoded} would revert if sent right now (${est.revert}). ` +
            `It may succeed once earlier steps land. Gas limit set to ${FALLBACK_EVM_GAS}.`,
        });
      }
    }

    const gasLimit: bigint = gas;
    const build = (base: StepBaseFields, signedBy: string): EvmTxStep => ({
      ...base,
      type: "evm-tx",
      chain,
      sender,
      derivation: { accountId: this.#sender, path },
      to: op.to,
      signature: op.signature,
      args: op.args,
      decoded: op.decoded,
      data: op.data,
      value: op.value,
      nonce,
      gas: gasLimit,
      ...fees,
      maxFee: gasLimit * fees.maxFeePerGas,
      signedBy,
    });
    if (this.#openBatch) {
      const req = this.#queueSign(path, signingHash(build(this.#base(op.description), "")).slice(2), "secp256k1", `${chain.label} transaction (nonce ${nonce})`);
      this.afterTx((txId) => {
        const step = build(this.#base(op.description), txId);
        req.forStep = step.id;
        this.steps.push(step);
      });
      return;
    }
    const signIndex = this.steps.length;
    const evmStep = build(this.#base(op.description, signIndex + 1), `s${signIndex + 1}`);
    const payloadHex = signingHash(evmStep).slice(2);
    await this.#emitSign(evmStep.id, path, payloadHex, "secp256k1", `step ${signIndex + 2} (${chain.label} transaction, nonce ${nonce})`);
    this.steps.push(evmStep);
  }

  /** Bitcoin payment: one MPC signature per input, then the broadcast. Inputs and fee pinned now. */
  async btcTransfer(chain: BtcChain, path: string, to: string, amount: bigint): Promise<void> {
    if (this.#scope.kind !== "seq" && !(this.#scope.kind === "batch" && this.#openBatch)) {
      throw this.#err("chainsig:transfer must be at the top level of the script or inside batch ( ... )");
    }
    const { address, publicKey } = await this.env.btc.derive(this.#sender, path);
    if (this.#btcFrom.has(address)) {
      throw this.#err(`one Bitcoin payment per address per script: ${address} already pays in an earlier step (its change is not confirmed yet)`);
    }
    this.#btcFrom.add(address);
    let prep;
    try {
      prep = await this.env.btc.prepare(chain, { from: address, publicKey, to, amount });
    } catch (e) {
      // No coins to spend yet: show the step and block the plan, instead of hiding the rest of it.
      this.checks.push({ level: "fail", description: `line ${this.line}: ${(e as Error).message}. Fund ${address} first.` });
      prep = { psbtHex: "", hashes: [], inputs: [], fee: 0n };
    }
    const n = prep.hashes.length;
    const what = `on ${chain.label}, send ${units(amount, 8)} BTC to ${to}`;
    const build = (base: StepBaseFields, signedBy: string[]): BtcTxStep => ({
      ...base,
      type: "btc-tx",
      chain,
      sender: address,
      publicKey,
      derivation: { accountId: this.#sender, path },
      to,
      amount,
      fee: prep.fee,
      maxFee: prep.fee,
      inputs: prep.inputs,
      psbtHex: prep.psbtHex,
      hashes: prep!.hashes,
      signedBy,
    });
    if (this.#openBatch) {
      const reqs = prep.hashes.map((h, i) =>
        this.#queueSign(path, h, "secp256k1", `${chain.label} payment${n > 1 ? `, input ${i + 1} of ${n}` : ""}`, { input: i }));
      this.afterTx((txId) => {
        const step = build(this.#base(what), reqs.map(() => txId));
        for (const r of reqs) r.forStep = step.id;
        this.steps.push(step);
      });
    } else {
      const first = this.steps.length;
      const btc = build(this.#base(what, first + n), prep.hashes.map((_, i) => `s${first + i + 1}`));
      for (let i = 0; i < n; i++) {
        await this.#emitSign(btc.id, path, prep.hashes[i], "secp256k1", `input ${i + 1} of ${n} of step ${first + n + 1} (${chain.label} payment)`, { input: i });
      }
      this.steps.push(btc);
    }
    if (!prep.hashes.length) return;
    const have = await this.env.btc.balance(chain, address);
    this.checks.push({
      level: have >= amount + prep.fee ? "ok" : "fail",
      description: `${address} on ${chain.label} has ${units(have, 8)} BTC; payment and fee need ${units(amount + prep.fee, 8)} BTC`,
    });
  }

  /** Solana transfer: the message is built right before signing, because blockhashes expire in about a minute. */
  async solTransfer(chain: SolChain, path: string, to: string, lamports: bigint): Promise<void> {
    if (this.#scope.kind !== "seq" && !(this.#scope.kind === "batch" && this.#openBatch)) {
      throw this.#err("chainsig:transfer must be at the top level of the script or inside batch ( ... )");
    }
    const sender = await this.env.sol.derive(this.#sender, path);
    const what = `on ${chain.label}, send ${units(lamports, 9)} SOL to ${to}`;
    const build = (base: StepBaseFields, signedBy: string): SolTxStep => ({
      ...base,
      type: "sol-tx",
      chain,
      sender,
      derivation: { accountId: this.#sender, path },
      to,
      lamports,
      maxFee: 5000n,
      signedBy,
    });
    const sol = build(this.#base(what), "");
    if (this.#openBatch) {
      const req = this.#queueSign(path, "", "ed25519", `${chain.label} transfer`, { late: true });
      this.afterTx((txId) => {
        const step = build(this.#base(what), txId);
        req.forStep = step.id;
        this.steps.push(step);
      });
    } else {
      const signIndex = this.steps.length;
      const step = build(this.#base(what, signIndex + 1), `s${signIndex + 1}`);
      await this.#emitSign(step.id, path, "", "ed25519", `step ${signIndex + 2} (${chain.label} transfer)`, { late: true });
      this.steps.push(step);
    }
    const [have, rent, toBal] = await Promise.all([
      this.env.sol.balance(chain, sender),
      this.env.sol.rentExempt(chain),
      this.env.sol.balance(chain, to).catch(() => 0n),
    ]);
    this.checks.push({
      level: have >= lamports + sol.maxFee ? "ok" : "fail",
      description: `${sender} on ${chain.label} has ${units(have, 9)} SOL; transfer and fee need ${units(lamports + sol.maxFee, 9)} SOL`,
    });
    if (toBal === 0n && lamports < rent) {
      this.checks.push({
        level: "fail",
        description: `line ${this.line}: ${to} has no SOL yet, so it must receive at least ${units(rent, 9)} SOL (rent exemption) or the transfer fails`,
      });
    }
  }

  /**
   * A check that runs again right before the next steps execute (e.g. "this quote has not expired").
   * Built from expressions so the executor re-evaluates it live, like a script's own assert.
   */
  async gate(left: Expr, op: "<" | "<=" | ">" | ">=" | "==" | "!=", right: Expr, message: string): Promise<void> {
    const planResult = await evalAssert(this, { left, op, right });
    this.steps.push({
      ...this.#base(message),
      type: "assert",
      phase: this.#txSeen ? "gate" : "preflight",
      left,
      op,
      right,
      message,
      vars: Object.fromEntries(this.vars),
      modules: [...this.modules.keys()],
      planResult,
    });
  }

  /** Append a step a module built itself (e.g. an off-chain wait). Its id and index are assigned here. */
  pushStep<T extends Step>(build: (base: { id: string; index: number; source: { line: number; text: string }; description: string }) => T, description: string): T {
    const step = build(this.#base(description));
    this.steps.push(step);
    return step;
  }

  /**
   * Run `fn` with the id of the transaction that carries the actions just added: right away at the
   * top level, or once the enclosing batch is emitted (its transaction does not exist yet).
   */
  afterTx(fn: (txStepId: string) => void): void {
    const scope = this.#openBatch;
    if (scope) {
      const stmt = this.#stmt;
      scope.after.push((id) => {
        const outer = this.#stmt;
        this.#stmt = stmt;
        try {
          fn(id);
        } finally {
          this.#stmt = outer;
        }
      });
      return;
    }
    fn(this.lastStepId);
  }

  /** id of the most recently added step. */
  get lastStepId(): string {
    return this.steps[this.steps.length - 1].id;
  }

  /**
   * An EVM transaction the user's own browser wallet signs (no Chain Signatures). Simulated now from
   * that address with eth_estimateGas; the wallet picks the nonce and fees when it sends.
   */
  async evmWalletCall(chain: EvmChain, from: `0x${string}`, op: Omit<EvmOp, "gas">): Promise<EvmWalletTxStep> {
    if (this.#scope.kind !== "seq") throw this.#err("a wallet transaction must be at the top level of the script");
    if (!this.#evmFees.has(chain.chainId)) this.#evmFees.set(chain.chainId, await this.env.evm.fees(chain));
    const fees = this.#evmFees.get(chain.chainId)!;
    const est = await this.env.evm.estimateGas(chain, { from, to: op.to, data: op.data, value: op.value });
    let gas: bigint;
    if ("gas" in est) gas = (est.gas * 13n) / 10n;
    else {
      gas = FALLBACK_EVM_GAS;
      this.checks.push({ level: "fail", description: `line ${this.line}: simulating ${op.decoded} from ${from} on ${chain.label} reverts: ${est.revert}` });
    }
    const step: EvmWalletTxStep = {
      ...this.#base(op.description),
      type: "evm-wallet-tx",
      chain,
      from,
      to: op.to,
      data: op.data,
      value: op.value,
      decoded: op.decoded,
      gas,
      maxFee: gas * fees.maxFeePerGas,
    };
    this.steps.push(step);
    this.#txSeen = true;
    return step;
  }

  // ------------------------------------------------------------------ blocks

  async block(stmts: Stmt[], scope: Scope): Promise<void> {
    const outer = this.#scope;
    this.#scope = scope;
    try {
      for (const s of stmts) await this.#statement(s);
    } finally {
      this.#scope = outer;
    }
  }

  /** `batch [<receiver>] ( ... )`: collect the block's actions into one transaction. */
  async batch(cmd: CommandStmt, receiver?: string): Promise<void> {
    if (this.#scope.kind !== "seq") {
      throw new ScriptError(`batch cannot be nested inside ${this.#scope.kind === "batch" ? "another batch" : this.#scope.kind === "meta" ? "a meta transaction" : "chainsig:on"}`, cmd.loc);
    }
    const scope: Extract<Scope, { kind: "batch" }> = { kind: "batch", receiver, actions: [], parts: [], after: [], signs: [] };
    this.#openBatch = scope;
    try {
      await this.block(cmd.block ?? [], scope);
    } finally {
      this.#openBatch = undefined;
    }
    this.#stmt = cmd;
    if (scope.actions.length === 0 || !scope.receiver) throw new ScriptError("batch is empty", cmd.loc);
    const signs = scope.signs;
    if (signs.length && signs.length !== scope.actions.length) {
      throw new ScriptError("a batch with chain signatures can hold only chainsig commands (all its actions are signature requests)", cmd.loc);
    }
    const tx = signs.length
      ? await this.#emitNear(this.#sender, scope.receiver, scope.actions,
          `ask the MPC network for ${signs.length} signature${signs.length > 1 ? "s" : ""} in one transaction: ${scope.parts.join("; ")}`,
          true, { kind: "mpc-sign-batch", signs })
      : await this.#emitNear(this.#sender, scope.receiver, scope.actions, `atomic batch on ${scope.receiver}: ${scope.parts.join("; ")}`, true);
    for (const fn of scope.after) fn(tx.id);
  }

  /** `as <account> ( ... )`: the block's NEAR transactions are signed by another account with a local key. */
  async as(cmd: CommandStmt, account: string): Promise<void> {
    if (this.#scope.kind !== "seq") throw new ScriptError("as ( ... ) must be at the top level of the script", cmd.loc);
    if (account !== this.env.near.accountId && !this.env.near.canSign(account)) {
      throw new ScriptError(`no local key for ${account}: as ( ... ) needs ~/.near-credentials/${this.env.near.network}/${account}.json`, cmd.loc);
    }
    const outer = this.#sender;
    this.#sender = account;
    try {
      await this.block(cmd.block ?? [], { kind: "seq" });
    } finally {
      this.#sender = outer;
    }
  }

  /**
   * NEP-366. `relayer` set: the relayer signs and pays for a transaction carrying the delegate.
   * `relayer` unset (meta:sign): only produce the SignedDelegate for an outside relayer.
   */
  async meta(cmd: CommandStmt, relayer: string | null, ttlBlocks: number): Promise<void> {
    if (this.#scope.kind !== "seq") throw new ScriptError("meta transactions must be at the top level of the script", cmd.loc);
    const sender = this.#sender;
    if (!this.env.near.canSign(sender)) {
      throw new ScriptError(`a meta transaction is signed by ${sender}, which needs a local key (wallets cannot sign delegate actions here)`, cmd.loc);
    }
    const scope: Scope = { kind: "meta", actions: [], parts: [] };
    await this.block(cmd.block ?? [], scope);
    this.#stmt = cmd;
    if (!scope.actions.length || !scope.receiver) throw new ScriptError("meta block is empty", cmd.loc);
    if (scope.actions.some((a) => a.kind === "delegate" || a.kind === "signed-delegate")) {
      throw new ScriptError("a meta transaction cannot contain another one", cmd.loc);
    }
    const summary = scope.parts.join("; ");
    if (relayer === null) {
      const step: DelegateSignStep = {
        ...this.#base(`sign a meta transaction for ${scope.receiver} (not sent; hand it to a relayer): ${summary}`),
        type: "delegate-sign",
        chain: { kind: "near", network: this.env.near.network },
        sender,
        receiver: scope.receiver,
        actions: scope.actions,
        ttlBlocks,
      };
      this.steps.push(step);
      return;
    }
    if (!this.env.near.canSign(relayer)) {
      throw new ScriptError(`relayer ${relayer} has no local key (a browser wallet cannot carry a signed delegate here)`, cmd.loc);
    }
    if (relayer === sender) throw new ScriptError("the relayer must be a different account from the sender", cmd.loc);
    await this.#emitNear(
      relayer,
      sender,
      [{ kind: "delegate", sender, receiver: scope.receiver, actions: scope.actions, decoded: `delegate from ${sender} to ${scope.receiver}: ${summary}` }],
      `relay a meta transaction: ${relayer} pays for ${sender} → ${scope.receiver}: ${summary}`,
      false,
    );
  }

  async #statement(s: Stmt): Promise<void> {
    this.#stmt = s;
    try {
      switch (s.kind) {
        case "load": {
          const m = MODULES[s.module];
          if (!m) throw new ScriptError(`unknown module "${s.module}" (available: ${Object.keys(MODULES).filter((k) => k !== "std").join(", ")})`, s.loc);
          this.modules.set(s.module, m);
          return;
        }
        case "set":
          this.vars.set(s.name, await this.eval(s.value));
          return;
        case "print": {
          const parts: string[] = [];
          for (const a of s.args) parts.push(show(await this.eval(a)));
          this.prints.push(parts.join(" "));
          return;
        }
        case "assert": {
          if (this.#scope.kind === "batch" || this.#scope.kind === "meta") {
            throw new ScriptError("assert cannot gate inside a batch or meta transaction: it is a single transaction. Put it before.", s.loc);
          }
          const planResult = await evalAssert(this, s);
          this.steps.push({
            ...this.#base(s.message ?? s.text),
            type: "assert",
            phase: this.#txSeen ? "gate" : "preflight",
            left: s.left,
            op: s.op,
            right: s.right,
            message: s.message,
            vars: Object.fromEntries(this.vars),
            modules: [...this.modules.keys()],
            planResult,
          });
          return;
        }
        case "command": {
          const full = s.module ? `${s.module}:${s.name}` : s.name;
          let fn;
          if (s.module) {
            const m = this.modules.get(s.module);
            if (!m) throw new ScriptError(`module "${s.module}" is not loaded (add: load ${s.module})`, s.loc);
            fn = m.commands[s.name];
          } else {
            fn = MODULES.std.commands[s.name] ?? (s.name === "exec" ? this.modules.get("chainsig")?.commands.exec : undefined);
            if (!fn) {
              const owner = [...this.modules.values()].find((m) => m.commands[s.name]) ??
                Object.values(MODULES).find((m) => m.commands[s.name]);
              if (owner) throw new ScriptError(`unknown command "${s.name}". Did you mean ${owner.name}:${s.name}?`, s.loc);
            }
          }
          if (!fn) throw new ScriptError(`unknown command "${full}"`, s.loc);
          await fn(this, s);
          return;
        }
      }
    } catch (e) {
      if (e instanceof ScriptError && e.loc) throw e;
      throw new ScriptError((e as Error).message, s.loc);
    }
  }

  /** Funding checks derived from the finished step list. */
  async finish(): Promise<void> {
    const nearNeed = new Map<string, bigint>();
    const add = (who: string, x: bigint) => nearNeed.set(who, (nearNeed.get(who) ?? 0n) + x);
    const evmNeed = new Map<string, { chain: EvmChain; sender: `0x${string}`; need: bigint }>();
    for (const s of this.steps) {
      if (s.type === "near-tx") add(s.sender, s.maxFee + s.actions.reduce((x, a) => x + actionDeposit(a), 0n));
      if (s.type === "evm-tx" || s.type === "evm-wallet-tx") {
        const sender = s.type === "evm-tx" ? s.sender : s.from;
        const k = `${s.chain.chainId}:${sender.toLowerCase()}`;
        const cur = evmNeed.get(k) ?? { chain: s.chain, sender, need: 0n };
        cur.need += s.maxFee + s.value;
        evmNeed.set(k, cur);
      }
    }
    for (const [who, x] of this.#locked) add(who, x);
    for (const [who, need] of nearNeed) {
      if (need === 0n) continue;
      if (this.created.has(who)) {
        this.checks.push({ level: "ok", description: `${who} is created by this script; its funding comes from the creating step` });
        continue;
      }
      const have = await this.env.near.balance(who);
      this.checks.push({
        level: have >= need ? "ok" : "fail",
        description: `${who} has ${near(have)}; fees, deposits and locked balance need at most ${near(need)}`,
      });
    }
    for (const { chain, sender, need } of evmNeed.values()) {
      const have = await this.env.evm.balance(chain, sender);
      const sym = chain.symbol;
      const fmt = (x: bigint) => eth(x).replace(/ETH$/, sym);
      this.checks.push({
        level: have >= need ? "ok" : "fail",
        description: have >= need
          ? `${sender} on ${chain.label} has ${fmt(have)}; gas and value need at most ${fmt(need)}`
          : `${sender} on ${chain.label} has ${fmt(have)} but gas and value need up to ${fmt(need)}. Fund this address before running.`,
      });
    }
  }
}

export { STORAGE_PRICE_PER_BYTE };

export const scriptHash = (source: string): string => sha256Hex(source);

/** Script text in, flat ordered step list out. Reads chain state; signs and sends nothing. */
export async function plan(source: string, env: Env): Promise<Plan> {
  const ast = parse(source);
  const ctx = new PlanCtx(env);
  await ctx.block(ast, { kind: "seq" });
  await ctx.finish();
  return {
    scriptHash: scriptHash(source),
    account: env.near.accountId,
    network: env.near.network,
    createdAt: new Date().toISOString(),
    steps: ctx.steps,
    checks: ctx.checks,
    prints: ctx.prints,
  };
}
