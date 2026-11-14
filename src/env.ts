import type { TxOutcome } from "./near/rpc.js";
import type { SignedNearTx } from "./near/tx.js";
import type { BtcTxStep, Chain, NearAction, SolTxStep } from "./plan/types.js";

export type EvmChain = Chain & { kind: "evm" };
export type BtcChain = Chain & { kind: "btc" };
export type SolChain = Chain & { kind: "sol" };
export type ForeignChain = EvmChain | BtcChain | SolChain;

export interface EvmCall {
  from: `0x${string}`;
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
}

export type EvmReceipt =
  | { state: "pending" }
  | { state: "success" | "reverted"; feePaid: bigint; blockNumber: bigint };

export interface NearAccountInfo {
  exists: boolean;
  amount: bigint;
  locked: bigint;
  /** base58; "11111111111111111111111111111111" means no contract. */
  codeHash: string;
}

export interface AccessKeyInfo {
  publicKey: string;
  permission: "full" | { receiver: string; methods: string[]; allowance: string | null };
}

export interface BtcPrepared {
  psbtHex: string;
  hashes: string[];
  inputs: { txid: string; vout: number; value: bigint }[];
  fee: bigint;
}

export interface IntentToken {
  assetId: string;
  decimals: number;
  /** 1Click blockchain id: near, eth, base, arb, op, pol, bsc, btc, sol, ... */
  blockchain: string;
  symbol: string;
  contractAddress?: string | null;
}

export type IntentStatus = "KNOWN_DEPOSIT_TX" | "PENDING_DEPOSIT" | "INCOMPLETE_DEPOSIT" | "PROCESSING" | "SUCCESS" | "REFUNDED" | "FAILED";

/** Everything the planner and executor need from the outside world. Tests substitute a fake. */
export interface Env {
  near: {
    network: string;
    /** The account the script runs as (wallet account in wallet mode). */
    accountId: string;
    signerContract: string;
    /** Account that creates top-level accounts (`testnet` / `near`). */
    registrar: string;
    view(contract: string, method: string, args?: unknown): Promise<any>;
    balance(accountId: string): Promise<bigint>;
    account(accountId: string): Promise<NearAccountInfo>;
    accessKeys(accountId: string): Promise<AccessKeyInfo[]>;
    gasPrice(): Promise<bigint>;
    /** Head of the chain (final). */
    height(): Promise<number>;
    /** True when a local key can sign for this account. False = the connected wallet signs. */
    canSign(accountId: string): boolean;
    /** Key for an account that is about to be created: reuse the saved one or make and save a new one. */
    newKey(accountId: string): { publicKey: string; file: string; created: boolean };
    /** Read a file named by a script (wasm for deploy). Relative to the script's directory. */
    readFile(path: string): Uint8Array;
    /**
     * Reads the next nonce and a recent block hash, signs locally with `sender`'s key. Sends nothing.
     * `delegate` actions are signed by their own sender first (NEP-366).
     */
    signTx(sender: string, receiver: string, actions: NearAction[]): Promise<SignedNearTx>;
    /** NEP-366: a SignedDelegate (base64) valid for `ttlBlocks`. Sends nothing. */
    signDelegate(sender: string, receiver: string, actions: NearAction[], ttlBlocks: number): Promise<{ base64: string; maxBlockHeight: bigint }>;
    broadcast(signedBase64: string): Promise<void>;
    status(txHash: string, sender: string): Promise<TxOutcome>;
    /**
     * Can a signed-but-unseen transaction still be accepted?
     * - "possible": its nonce is unused and its block hash is still valid. Keep waiting; never re-sign.
     * - "impossible": its nonce is unused and its block hash has expired. It never landed and never will.
     * - "ambiguous": its nonce has been used, by it or by something else. Needs a human.
     */
    landing(sender: string, publicKey: string, blockHash: string, nonce: bigint): Promise<"possible" | "impossible" | "ambiguous">;
  };
  /** Any chain a script can name in chainsig:*. Throws with the available names if unknown. */
  chain(name: string): ForeignChain;
  chainNames(): string[];
  evm: {
    derive(accountId: string, path: string): Promise<`0x${string}`>;
    balance(chain: EvmChain, address: `0x${string}`): Promise<bigint>;
    erc20Balance(chain: EvmChain, token: `0x${string}`, owner: `0x${string}`): Promise<bigint>;
    erc20Decimals(chain: EvmChain, token: `0x${string}`): Promise<number>;
    nonce(chain: EvmChain, address: `0x${string}`): Promise<number>;
    fees(chain: EvmChain): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
    estimateGas(chain: EvmChain, call: EvmCall): Promise<{ gas: bigint } | { revert: string }>;
    send(chain: EvmChain, raw: `0x${string}`): Promise<void>;
    receipt(chain: EvmChain, hash: `0x${string}`): Promise<EvmReceipt>;
  };
  btc: {
    derive(accountId: string, path: string): Promise<{ address: string; publicKey: string }>;
    balance(chain: BtcChain, address: string): Promise<bigint>;
    /** Select UTXOs, pin the fee, build the unsigned PSBT and one sighash per input. */
    prepare(chain: BtcChain, req: { from: string; publicKey: string; to: string; amount: bigint }): Promise<BtcPrepared>;
    /** Attach signatures (64-byte r||s hex per input), verify them, return the raw tx and its txid. */
    finalize(step: BtcTxStep, signatures: string[]): { raw: string; txid: string };
    send(chain: BtcChain, raw: string): Promise<void>;
    status(chain: BtcChain, txid: string): Promise<"confirmed" | "mempool" | "unknown">;
  };
  /** NEAR Intents through the 1Click API (mainnet only). */
  intents: {
    tokens(): Promise<IntentToken[]>;
    /** dry=false returns a deposit address; nothing moves until something is sent to it. */
    quote(req: Record<string, unknown>): Promise<any>;
    status(depositAddress: string, memo?: string): Promise<{ status: IntentStatus; swapDetails?: any; quoteResponse?: any }>;
    /** Tell 1Click about the deposit transaction so it does not wait to notice it. Best effort. */
    submit(txHash: string, depositAddress: string, memo?: string): Promise<void>;
  };
  sol: {
    derive(accountId: string, path: string): Promise<string>;
    balance(chain: SolChain, address: string): Promise<bigint>;
    /** Minimum balance for a new system account to exist (rent exemption). */
    rentExempt(chain: SolChain): Promise<bigint>;
    /** Build the transfer message with a fresh blockhash. */
    prepare(step: SolTxStep): Promise<{ messageBase64: string; blockhash: string; lastValidBlockHeight: number }>;
    /** Attach the 64-byte ed25519 signature, verify it, return the wire tx (base64) and its signature id. */
    finalize(step: SolTxStep, messageBase64: string, signature: Uint8Array): { raw: string; txid: string };
    send(chain: SolChain, raw: string): Promise<void>;
    /** "expired": not landed and its blockhash can no longer land. */
    status(chain: SolChain, txid: string, lastValidBlockHeight: number): Promise<{ state: "success" | "failed" | "pending" | "expired"; error?: string; fee?: bigint }>;
  };
}
