import { keccak256, toHex } from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";
import type { Env, EvmReceipt } from "../src/env.js";
import type { TxOutcome } from "../src/near/rpc.js";

export const ME = "me.testnet";
export const USDC_NEAR = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
export const USDC_BASE = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
export const DERIVED = privateKeyToAccount(PK).address;

export interface Fake extends Env {
  /** Everything that touched the outside world, in order. */
  calls: string[];
  registered: Set<string>;
  ethBalance: bigint;
  usdcNear: bigint;
  /** NEAR transactions the "network" has accepted: hash -> outcome. */
  nearTxs: Map<string, TxOutcome>;
  evmTxs: Map<string, EvmReceipt>;
  keyNonce: bigint;
  /** Hooks to script failures. */
  onNearBroadcast?: (hash: string, receiver: string) => TxOutcome | "drop";
  onEvmSend?: (hash: string) => EvmReceipt | "drop";
  landingVerdict?: "possible" | "impossible" | "ambiguous";
  estimateRevert?: string;
  /** Accounts with a local key (others are signed by the "wallet"). */
  keyAccounts: Set<string>;
  missing: Set<string>;
  codeHash: Map<string, string>;
  keys: { publicKey: string; permission: "full" }[];
  eddsaPayloads: string[];
  solPrepares: number;
  intentQuotes: any[];
  intentStatuses: string[];
  intentSubmits: string[];
  solStatus: (txid: string) => { state: "success" | "failed" | "pending" | "expired"; error?: string; fee?: bigint };
}

/** An in-memory NEAR + EVM world. The MPC "network" signs with a local key so signatures really verify. */
export function fakeEnv(): Fake {
  const signedByHash = new Map<string, { receiver: string; actions: any[]; nonce: bigint }>();
  const b64ToHash = new Map<string, string>();
  const f: Fake = {
    calls: [],
    registered: new Set([ME]),
    ethBalance: 10n ** 16n,
    usdcNear: 20_000_000n,
    nearTxs: new Map(),
    evmTxs: new Map(),
    keyNonce: 100n,
    keyAccounts: new Set([ME, "relayer.testnet", "app.me.testnet"]),
    missing: new Set(),
    codeHash: new Map(),
    keys: [{ publicKey: "ed25519:GnRLkCws5rbcpmcxqAawMQjaoNeojB57JQAz8KYq6dWk", permission: "full" }],
    eddsaPayloads: [],
    solPrepares: 0,
    solStatus: () => ({ state: "success", fee: 5000n }),
    intentQuotes: [],
    intentStatuses: ["PROCESSING", "SUCCESS"],
    intentSubmits: [],
    intents: {
      tokens: async () => INTENT_TOKENS,
      async quote(req: any) {
        f.intentQuotes.push(req);
        f.calls.push(`intents.quote dry=${req.dry}`);
        const out = (BigInt(req.amount) * 999n) / 1000n;
        return {
          correlationId: "corr-1",
          quote: {
            depositAddress: req.originAsset.startsWith("nep141:17208628") ? "aa".repeat(32) : "0x1111111111111111111111111111111111111111",
            amountIn: req.amount, amountOut: out.toString(), minAmountOut: ((out * 995n) / 1000n).toString(),
            deadline: req.deadline, timeEstimate: 20,
          },
        };
      },
      async status() {
        const st = f.intentStatuses.length > 1 ? f.intentStatuses.shift()! : f.intentStatuses[0];
        return {
          status: st as any,
          swapDetails: st === "SUCCESS"
            ? { amountOutFormatted: "9.99", destinationChainTxHashes: [{ hash: "0xdest", explorerUrl: "https://arbiscan.io/tx/0xdest" }] }
            : st === "REFUNDED" ? { refundedAmountFormatted: "10", refundReason: "price moved" } : {},
        };
      },
      async submit(tx) {
        f.intentSubmits.push(tx);
      },
    },
    near: {
      network: "testnet",
      accountId: ME,
      signerContract: "v1.signer-prod.testnet",
      registrar: "testnet",
      async view(contract, method, args: any) {
        f.calls.push(`view ${method}`);
        if (method === "ft_metadata") return { decimals: 6, symbol: "USDC" };
        if (method === "storage_balance_of") return f.registered.has(args.account_id) ? { total: "1250000000000000000000" } : null;
        if (method === "storage_balance_bounds") return { min: "1250000000000000000000", max: "1250000000000000000000" };
        if (method === "ft_balance_of") return f.usdcNear.toString();
        if (method === "get_number") return 7;
        if (method === "nft_token") return { token_id: args.token_id, owner_id: ME };
        throw new Error(`fake view: ${contract}.${method}`);
      },
      balance: async () => 5n * 10n ** 24n,
      async account(id) {
        const exists = !id.startsWith("new") && !f.missing.has(id);
        return { exists, amount: exists ? 5n * 10n ** 24n : 0n, locked: 0n, codeHash: f.codeHash.get(id) ?? "11111111111111111111111111111111" };
      },
      accessKeys: async () => f.keys,
      gasPrice: async () => 100_000_000n,
      height: async () => 1000,
      canSign: (id) => f.keyAccounts.has(id),
      newKey: (id) => ({ publicKey: "ed25519:GnRLkCws5rbcpmcxqAawMQjaoNeojB57JQAz8KYq6dWk", file: `/keys/${id}.json`, created: true }),
      readFile: (p) => {
        if (p.endsWith(".wasm")) return Uint8Array.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
        throw new Error(`no such file ${p}`);
      },
      async signTx(sender, receiver, actions) {
        const nonce = ++f.keyNonce;
        const hash = `near-${receiver.slice(0, 6)}-${nonce}`;
        const base64 = Buffer.from(hash).toString("base64");
        signedByHash.set(hash, { receiver, actions, nonce });
        b64ToHash.set(base64, hash);
        f.calls.push(`near.sign ${hash} by ${sender}`);
        return { hash, base64, nonce, blockHash: "blk", publicKey: "ed25519:fake" };
      },
      async signDelegate(sender, receiver) {
        f.calls.push(`near.signDelegate ${sender}->${receiver}`);
        return { base64: Buffer.from(`delegate:${sender}:${receiver}`).toString("base64"), maxBlockHeight: 1600n };
      },
      async broadcast(b64) {
        const hash = b64ToHash.get(b64)!;
        f.calls.push(`near.broadcast ${hash}`);
        if (f.nearTxs.has(hash)) return;
        const tx = signedByHash.get(hash)!;
        const scripted = f.onNearBroadcast?.(hash, tx.receiver);
        if (scripted === "drop") return;
        if (scripted) {
          f.nearTxs.set(hash, scripted);
          return;
        }
        let value: unknown = null;
        const signs = tx.actions.filter((a: any) => a.kind === "call" && a.method === "sign");
        if (signs.length > 1) {
          // Several sign requests: each answers in its own receipt. Returned in reverse order, so the
          // executor must match signatures to payments by verifying them, not by position.
          const values: unknown[] = [];
          for (const a of signs as any[]) {
            const p2 = a.args.request.payload_v2;
            if (p2.Eddsa !== undefined) {
              f.eddsaPayloads.push(p2.Eddsa);
              values.push({ scheme: "Ed25519", signature: Array.from({ length: 64 }, (_, i) => i) });
              continue;
            }
            const s = await sign({ hash: `0x${p2.Ecdsa}` as `0x${string}`, privateKey: PK });
            values.push({ scheme: "Secp256k1", big_r: { affine_point: `02${s.r.slice(2)}` }, s: { scalar: s.s.slice(2) }, recovery_id: s.yParity });
          }
          values.reverse();
          f.nearTxs.set(hash, { state: "success", value: values[values.length - 1], values, tokensBurnt: 10n ** 20n });
          return;
        }
        if (tx.actions[0].method === "sign") {
          const p2 = tx.actions[0].args.request.payload_v2;
          if (p2.Eddsa !== undefined) {
            f.eddsaPayloads.push(p2.Eddsa);
            value = { scheme: "Ed25519", signature: Array.from({ length: 64 }, (_, i) => i) };
            for (const a of tx.actions) if (a.kind === "call" && a.method === "storage_deposit") f.registered.add(a.args.account_id);
            f.nearTxs.set(hash, { state: "success", value, tokensBurnt: 10n ** 20n });
            return;
          }
          const payload = `0x${p2.Ecdsa}` as `0x${string}`;
          const s = await sign({ hash: payload, privateKey: PK });
          value = {
            scheme: "Secp256k1",
            big_r: { affine_point: `02${s.r.slice(2)}` },
            s: { scalar: s.s.slice(2) },
            recovery_id: s.yParity,
          };
        }
        for (const a of tx.actions) if (a.kind === "call" && a.method === "storage_deposit") f.registered.add(a.args.account_id);
        f.nearTxs.set(hash, { state: "success", value, tokensBurnt: 10n ** 20n });
      },
      async status(hash) {
        return f.nearTxs.get(hash) ?? { state: "unknown" };
      },
      landing: async () => f.landingVerdict ?? "possible",
    },
    chain(name) {
      if (name === "base") return { kind: "evm", name: "base", label: "Base Sepolia", chainId: 84532, symbol: "ETH" };
      if (name === "arbitrum") return { kind: "evm", name: "arbitrum", label: "Arbitrum", chainId: 42161, symbol: "ETH" };
      if (name === "bitcoin") return { kind: "btc", name: "bitcoin", label: "Bitcoin testnet", network: "testnet" };
      if (name === "solana") return { kind: "sol", name: "solana", label: "Solana devnet", cluster: "devnet" };
      throw new Error(`unknown chain "${name}" (available: base, bitcoin, solana)`);
    },
    chainNames: () => ["base", "arbitrum", "bitcoin", "solana"],
    btc: {
      derive: async () => ({ address: "tb1qfakeaddress", publicKey: "02" + "11".repeat(32) }),
      balance: async () => 100_000n,
      async prepare(_c, req) {
        f.calls.push(`btc.prepare ${req.amount}`);
        return {
          psbtHex: "70736274ff", hashes: ["aa".repeat(32), "bb".repeat(32)],
          inputs: [{ txid: "11".repeat(32), vout: 0, value: 30_000n }, { txid: "22".repeat(32), vout: 1, value: 40_000n }], fee: 500n,
        };
      },
      finalize(step, sigs) {
        f.calls.push(`btc.finalize ${sigs.length}`);
        return { raw: `btcraw-${step.id}`, txid: "cc".repeat(32) };
      },
      async send(_c, raw) {
        f.calls.push(`btc.send ${raw}`);
      },
      status: async () => "confirmed",
    },
    sol: {
      derive: async () => "So1Fake1111111111111111111111111111111111111",
      balance: async () => 2n * 10n ** 9n,
      rentExempt: async () => 890_880n,
      async prepare() {
        f.solPrepares++;
        return { messageBase64: Buffer.from(`msg-${f.solPrepares}`).toString("base64"), blockhash: `bh${f.solPrepares}`, lastValidBlockHeight: 100 };
      },
      finalize(step, msg, sig) {
        f.calls.push(`sol.finalize ${Buffer.from(msg, "base64").toString()} ${sig.length}`);
        return { raw: `solraw-${Buffer.from(msg, "base64").toString()}`, txid: `soltx-${Buffer.from(msg, "base64").toString()}` };
      },
      async send(_c, raw) {
        f.calls.push(`sol.send ${raw}`);
      },
      async status(_c, txid) {
        return f.solStatus(txid);
      },
    },
    evm: {
      derive: async () => DERIVED,
      balance: async () => f.ethBalance,
      erc20Balance: async () => 5_000_000n,
      erc20Decimals: async () => 6,
      nonce: async () => 3,
      fees: async () => ({ maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 1_000n }),
      estimateGas: async () => (f.estimateRevert ? { revert: f.estimateRevert } : { gas: 50_000n }),
      async send(_c, raw) {
        const hash = keccak256(raw);
        f.calls.push(`evm.send ${hash.slice(0, 10)}`);
        if (f.evmTxs.has(hash)) return;
        const scripted = f.onEvmSend?.(hash);
        if (scripted === "drop") return;
        f.evmTxs.set(hash, scripted ?? { state: "success", feePaid: 5n * 10n ** 10n, blockNumber: 1n });
      },
      async receipt(_c, hash) {
        return f.evmTxs.get(hash) ?? { state: "pending" };
      },
    },
  };
  void toHex;
  return f;
}

/** A slice of the real 1Click token list. */
export const INTENT_TOKENS = [
  { assetId: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", decimals: 6, blockchain: "near", symbol: "USDC", contractAddress: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1" },
  { assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", decimals: 6, blockchain: "base", symbol: "USDC", contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
  { assetId: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", decimals: 6, blockchain: "arb", symbol: "USDC", contractAddress: "0xaf88d065e77c8cc2239327c5edb3a432268e5831" },
  { assetId: "nep141:base.omft.near", decimals: 18, blockchain: "base", symbol: "ETH", contractAddress: null },
  { assetId: "nep141:sol.omft.near", decimals: 9, blockchain: "sol", symbol: "SOL", contractAddress: null },
  { assetId: "nep245:v2_1.omni.hot.tg:56_11111111111111111111", decimals: 18, blockchain: "bsc", symbol: "BNB(DEPRECATED)", contractAddress: null },
  { assetId: "nep141:tron-usdt.omft.near", decimals: 6, blockchain: "tron", symbol: "USDT", contractAddress: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" },
];

export const EXAMPLE = `load token
load chainsig

set $treasury @chainsig:address(base "treasury")
assert @chainsig:balance(base "treasury" ETH) > 0.0001e18

token:transfer USDC alice.testnet 1
chainsig:on base "treasury" (
  exec @token(USDC) "transfer(address,uint256)" 0x000000000000000000000000000000000000dEaD 1e6
)
`;
