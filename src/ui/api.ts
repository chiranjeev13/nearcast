/**
 * The contract between the local server (src/ui/server.ts) and the web UI (web/).
 * Every request is POST /api/<name> with a JSON body and the header `x-nearcast-token`,
 * whose value the server injects into index.html as <meta name="nearcast-token" content="...">.
 * Errors come back as HTTP 400 { error: string, line?: number } (line = script line, 1-based).
 * Bigints never cross this boundary: amounts are preformatted strings or decimal strings.
 */

// ---------------------------------------------------------------- docs (also drives autocomplete)

export interface OptDoc {
  /** Without the leading dashes. */
  name: string;
  /** e.g. "<amount>". */
  value?: string;
  summary: string;
}

export interface EntryDoc {
  /** "command" | "helper" | "keyword" (load, set, print, assert). */
  kind: "command" | "helper" | "keyword";
  /** Module name; "std" for built-ins usable without a prefix, "" for keywords. */
  module: string;
  /** Bare name, e.g. "transfer". */
  name: string;
  /** What the user types to call it: "token:transfer", "call", "@token:balance", "@me", "load". */
  insert: string;
  /** One line, e.g. 'token:transfer <token> <recipient> <amount> [--memo "text"]'. */
  usage: string;
  /** One short sentence. */
  summary: string;
  /** Optional longer notes (a few sentences at most). */
  details?: string;
  example?: string;
  opts?: OptDoc[];
  /** True when the command takes a ( ... ) block. */
  block?: boolean;
  /** Where it acts: "near", "evm", "bitcoin", "solana", or "any". Informational. */
  chains?: string[];
}

export interface ModuleDoc {
  name: string;
  summary: string;
  /** True for std: always loaded, its commands need no prefix. */
  builtin: boolean;
}

export interface ChainDoc {
  /** Name used in scripts: "base", "ethereum", "bitcoin", "solana", ... */
  name: string;
  label: string;
  kind: "evm" | "btc" | "sol";
  /** Native asset symbol: ETH, POL, BNB, BTC, SOL. */
  symbol: string;
  decimals: number;
  /** Known token symbols on this chain (EVM only). */
  tokens: string[];
}

export interface Docs {
  modules: ModuleDoc[];
  entries: EntryDoc[];
  /** Per network. */
  chains: Record<string, ChainDoc[]>;
  /** NEAR token symbols per network, e.g. { testnet: ["USDC", "wNEAR"] }. */
  nearTokens: Record<string, string[]>;
  /**
   * Assets NEAR Intents can move, as script writes them (`base:USDC`, `near:wNEAR`), from the live
   * 1Click token list. Empty if it could not be fetched. Mainnet assets.
   */
  intentAssets?: { ref: string; chain: string; symbol: string; known: boolean }[];
  /** Literal suffixes: 1near, 30tgas, 1yocto. */
  units: { suffix: string; summary: string }[];
}

// ---------------------------------------------------------------- session context

export type Network = "testnet" | "mainnet";

/**
 * Who signs. "key": the server signs with a local key (NEAR_PRIVATE_KEY or ~/.near-credentials).
 * "wallet": the browser's connected wallet signs each NEAR transaction; the server still plans,
 * executes, checkpoints and broadcasts the other chains' transactions.
 */
export type SignerMode = "key" | "wallet";

/** Sent with every request below (except info/docs). */
export interface Ctx {
  network: Network;
  account: string;
  signer: SignerMode;
  /**
   * Wallet Selector module id of the connected wallet ("meteor-wallet", "ethereum-wallets", ...).
   * The server uses it for wallet-specific limits: MetaMask (ethereum-wallets) splits a multi-action
   * transaction into one transaction per action, so atomic steps are blocked for it.
   */
  walletId?: string;
  /** Address of the EVM wallet connected in the browser (MetaMask etc.), if any. Used by `--from-wallet`. */
  evmAccount?: string;
}

// ---------------------------------------------------------------- requests and responses

/** POST /api/info  {} */
export interface InfoResponse {
  networks: Network[];
  /** Network the server was started with (default for the UI). */
  defaultNetwork: Network;
  /** Accounts the server holds a key for, per network (can be empty: then only wallet mode works). */
  keyAccounts: Record<string, string[]>;
  /** Default account for key mode, if any. */
  defaultAccount?: string;
  examples: { name: string; source: string }[];
  /** Script to open first. */
  initial: string;
  docs: Docs;
}

/**
 * Workspace files: plain `.cast` files in one folder on disk (no subfolders).
 * POST /api/files   {}                         -> { dir, files: FileEntry[] }
 * POST /api/read    { name }                   -> { name, source }
 * POST /api/write   { name, source, create? }  -> FileEntry   (create: fail if it exists)
 * POST /api/rename  { from, to }               -> FileEntry
 * POST /api/delete  { name }                   -> { ok: true }
 */
export interface FileEntry {
  name: string;
  size: number;
  mtime: string;
}

/** POST /api/plan  { ctx, source, fresh?: boolean } -> Snapshot */
/** POST /api/state { ctx, hash } -> Snapshot   (poll this ~1/s while running) */
/** POST /api/run   { ctx, hash, fresh?: boolean } -> Snapshot   (only a plan the user has seen) */
/** POST /api/resume { ctx, hash, retryFailed?: boolean } -> Snapshot */
/** POST /api/kill  { ctx, hash } -> { ok: true }   (simulates a crash at the next checkpoint write) */

/**
 * POST /api/wallet  { ctx, hash, id, txHash?: string, error?: string } -> Snapshot
 * The browser's answer to Snapshot.walletRequest: the hash of the transaction the wallet sent,
 * or an error (user rejected, wallet failed). Send it exactly once per request id.
 */

/**
 * POST /api/handoff  { ctx, hash, step: string, txHash?: string, notSent?: boolean } -> Snapshot
 * Resolves Snapshot.handoff: a wallet request whose outcome was never recorded (page closed,
 * crash). The user either supplies the hash they see in the wallet/explorer, or says it was
 * not sent, which lets resume ask the wallet again.
 */

export type StepStatus = "planned" | "signed" | "broadcast" | "confirmed" | "failed";

/**
 * Risk labels, shown as tags: [READ-ONLY] [STATE-CHANGING] [IRREVERSIBLE] [HIGH-VALUE].
 * read-only: checks. state-changing: any transaction. irreversible: deletes an account or key,
 * deploys over code, moves value out on another chain. high-value: moves or locks more than a
 * threshold (mainnet: any value transfer).
 */
export type Risk = "read-only" | "state-changing" | "irreversible" | "high-value";

export interface StepView {
  n: number;
  id: string;
  /** check = assert; near / evm / btc / sol = a transaction on that chain; local = signed only, not sent (meta:sign);
   *  wait = off-chain wait for a third party (NEAR Intents solvers), sends nothing. */
  kind: "check" | "near" | "evm" | "btc" | "sol" | "local" | "wait";
  /** Short chain label: "NEAR testnet", "Base Sepolia", "Bitcoin testnet4", "Solana devnet", "preflight check", "gate". */
  chain: string;
  /** Short title, e.g. "Transfer 1 USDC to alice.testnet". */
  title: string;
  /** Script line and its text. */
  line: number;
  text: string;
  /** Label/value pairs shown in the step card: from, to, value, max fee, ... */
  rows: [string, string][];
  /** NEAR actions inside this transaction, one line each. */
  actions: string[];
  /** More than one action in one transaction: all succeed or none do. */
  atomic: boolean;
  /** Needs a strong visual warning (delete account, full-access key, deploy over existing code, mainnet value...). */
  danger?: string;
  status: StepStatus;
  txHash?: string;
  url?: string;
  error?: string;
  fee?: string;
  result?: string;
  /** Account that signs this step (NEAR steps). */
  signer?: string;
  /** "wallet" when the connected wallet must sign it, "key" for a server key, "mpc" for other chains. */
  signedWith?: "wallet" | "key" | "mpc";
  /** Risk tags, most severe last. */
  risk: Risk[];
  /** On failure or a stuck wait: likely cause and the next safe action, one or two short lines. */
  hint?: string;
}

export interface PlanView {
  hash: string;
  account: string;
  network: Network;
  steps: StepView[];
  /** Output of print statements. */
  prints: string[];
  checks: { level: "ok" | "warn" | "fail"; description: string }[];
  /** Non-empty = cannot run. */
  problems: string[];
  txCount: number;
  chainCount: number;
  /** e.g. "NEAR fees up to 0.006 NEAR, deposits 0.00125 NEAR, EVM gas up to 0.00001 ETH". */
  cost: string;
  /** Number of NEAR transactions the connected wallet will be asked to approve. */
  walletTxCount: number;
  /** Highest risk across steps (for the "Mode: ... | Network: ... | Risk: [...]" header). */
  risk: Risk;
  /** What the dry run actually tested, one short line each (e.g. "EVM gas estimated on Base Sepolia", "balances read"). */
  simulated: string[];
}

/** A NEAR transaction the browser must have the wallet sign and send. Wallet Selector's action JSON. */
export interface WalletRequest {
  id: string;
  /** "near": sign with the NEAR wallet (actions below). "evm": send `evm` with the browser's EVM wallet. */
  kind: "near" | "evm";
  evm?: {
    chainId: number;
    chainName: string;
    from: string;
    to: string;
    data: string;
    /** wei, decimal string */
    value: string;
    /** For wallet_addEthereumChain if the wallet does not know the chain. */
    rpcUrl: string;
    explorer: string;
    symbol: string;
  };
  /** Step number it belongs to (1-based) and its title. */
  step: number;
  title: string;
  signerId: string;
  receiverId: string;
  actions: WalletAction[];
}

/** Matches @near-wallet-selector/core's legacy Action shape. Amounts/gas are decimal strings. */
export type WalletAction =
  | { type: "FunctionCall"; params: { methodName: string; args: object; gas: string; deposit: string } }
  | { type: "Transfer"; params: { deposit: string } }
  | { type: "CreateAccount" }
  | { type: "DeleteAccount"; params: { beneficiaryId: string } }
  | {
      type: "AddKey";
      params: {
        publicKey: string;
        accessKey: { nonce?: number; permission: "FullAccess" | { receiverId: string; methodNames: string[]; allowance?: string } };
      };
    }
  | { type: "DeleteKey"; params: { publicKey: string } }
  /** code: base64 of the wasm; the browser must turn it into a Uint8Array. */
  | { type: "DeployContract"; params: { code: string } }
  | { type: "Stake"; params: { stake: string; publicKey: string } };

export interface Snapshot {
  hash: string;
  /** null: nothing planned yet for this script text. */
  view: PlanView | null;
  /** none = preview only. unfinished / complete = a checkpoint exists for this exact script. */
  run: "none" | "unfinished" | "complete";
  inFlight?: number;
  running?: boolean;
  /** Human log lines from the executor. */
  log?: string[];
  /** Final line of the last run attempt. */
  outcome?: string;
  /** Present while the executor waits for the browser's wallet. */
  walletRequest?: WalletRequest;
  /** Present when a wallet request's outcome is unknown and a human must decide. */
  handoff?: { step: number; stepId: string; title: string; since: string; account: string };
}
