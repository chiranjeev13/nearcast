import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { chainAdapters, contracts } from "chainsig.js";
import { createPublicClient, erc20Abi, http, type PublicClient } from "viem";
import { btcEnv } from "./chains/btc.js";
import { intentsEnv } from "./chains/intents.js";
import { solEnv } from "./chains/sol.js";
import type { AccessKeyInfo, Env, EvmChain, ForeignChain } from "./env.js";
import type { KeyRing } from "./near/keys.js";
import { NearRpc, NearRpcError, NEAR_RPC_DEFAULTS } from "./near/rpc.js";
import { toProtocolAction } from "./near/tx.js";
import type { NearAction } from "./plan/types.js";
import { CHAINS, isNetwork, MPC_SIGNER, NEAR_EXPLORER, REGISTRAR, type EvmDef } from "./registry.js";

export interface LiveOptions {
  network: string;
  /** The account the script runs as. In wallet mode no local key is needed for it. */
  accountId: string;
  keys: KeyRing;
  /** Directory that relative file paths in scripts (wasm) resolve against. */
  baseDir?: string;
}

const DELEGATE_TTL = 600n;

/** The real Env: NEAR JSON-RPC, viem for EVM, Esplora for Bitcoin, web3.js for Solana, chainsig.js for derivation. */
export function liveEnv(o: LiveOptions): Env {
  const { network, accountId, keys } = o;
  if (!isNetwork(network)) throw new Error(`unknown network "${network}" (testnet or mainnet)`);
  const rpc = new NearRpc(process.env.NEAR_RPC_URL ? [process.env.NEAR_RPC_URL] : NEAR_RPC_DEFAULTS[network]);
  const signerContract = MPC_SIGNER[network];
  const chains = CHAINS[network];
  const evmDefs = Object.values(chains).filter((c): c is EvmDef => c.kind === "evm");
  const clients = new Map<number, PublicClient>();
  const client = (c: EvmChain): PublicClient => {
    let cl = clients.get(c.chainId);
    if (!cl) {
      const def = evmDefs.find((x) => x.chainId === c.chainId)!;
      cl = createPublicClient({ transport: http(process.env[def.rpcEnv] ?? def.rpc) }) as PublicClient;
      clients.set(c.chainId, cl);
    }
    return cl;
  };
  const derived = new Map<string, `0x${string}`>();
  let validity: number | undefined;

  /** Next nonce for a key; delegates use it too. */
  const nextNonce = async (account: string, publicKey: string): Promise<bigint> => {
    const key = await rpc.accessKey(account, publicKey);
    return key.nonce + 1n;
  };

  const signDelegate = async (sender: string, receiver: string, actions: NearAction[], ttl: bigint) => {
    const signer = keys.signer(sender);
    const head = await rpc.finalBlock();
    const maxBlockHeight = BigInt(head.height) + ttl;
    const base64 = signer.signDelegate(receiver, actions, { nonce: await nextNonce(sender, signer.publicKey), maxBlockHeight });
    return { base64, maxBlockHeight };
  };

  return {
    near: {
      network,
      accountId,
      signerContract,
      registrar: REGISTRAR[network],
      view: (c, m, a) => rpc.view(c, m, a ?? {}),
      balance: async (id) => (await rpc.account(id)).amount,
      async account(id) {
        try {
          const r = await rpc.call("query", { request_type: "view_account", finality: "final", account_id: id });
          return { exists: true, amount: BigInt(r.amount), locked: BigInt(r.locked), codeHash: r.code_hash };
        } catch (e) {
          if (e instanceof NearRpcError && e.name_ === "UNKNOWN_ACCOUNT") return { exists: false, amount: 0n, locked: 0n, codeHash: "" };
          throw e;
        }
      },
      async accessKeys(id) {
        const r = await rpc.call("query", { request_type: "view_access_key_list", finality: "final", account_id: id });
        return (r.keys ?? []).map((k: any): AccessKeyInfo => {
          const p = k.access_key.permission;
          return {
            publicKey: k.public_key,
            permission: p === "FullAccess" ? "full" : { receiver: p.FunctionCall.receiver_id, methods: p.FunctionCall.method_names, allowance: p.FunctionCall.allowance },
          };
        });
      },
      gasPrice: () => rpc.gasPrice(),
      height: async () => (await rpc.finalBlock()).height,
      canSign: (id) => keys.has(id),
      newKey: (id) => keys.ensureNew(id),
      readFile(path) {
        const p = isAbsolute(path) ? path : resolve(o.baseDir ?? process.cwd(), path);
        return new Uint8Array(readFileSync(p));
      },
      async signTx(sender, receiver, actions) {
        const signer = keys.signer(sender);
        const key = await rpc.accessKey(sender, signer.publicKey);
        if (key.permission !== "FullAccess") {
          throw new Error(`the local key for ${sender} is not a full-access key; function-call keys cannot attach deposits`);
        }
        const protocol = [];
        for (const a of actions) {
          if (a.kind === "delegate") {
            const d = await signDelegate(a.sender, a.receiver, a.actions, DELEGATE_TTL);
            protocol.push(toProtocolAction({ kind: "signed-delegate", base64: d.base64, sender: a.sender, receiver: a.receiver, decoded: a.decoded }));
          } else protocol.push(toProtocolAction(a));
        }
        const block = await rpc.finalBlock();
        return signer.sign(receiver, protocol, key.nonce + 1n, block.hash);
      },
      signDelegate: (sender, receiver, actions, ttl) => signDelegate(sender, receiver, actions, BigInt(ttl)),
      broadcast: (b64) => rpc.broadcast(b64),
      status: (hash, sender) => rpc.txStatus(hash, sender),
      async landing(sender, publicKey, blockHash, nonce) {
        const key = await rpc.accessKey(sender, publicKey);
        if (key.nonce >= nonce) return "ambiguous";
        validity ??= (await rpc.call("EXPERIMENTAL_genesis_config", {})).transaction_validity_period as number;
        const base = await rpc.blockHeight(blockHash);
        if (base === null) return "possible"; // cannot prove expiry
        const head = await rpc.finalBlock();
        return head.height - base > validity ? "impossible" : "possible";
      },
    },
    chain(name): ForeignChain {
      const c = chains[name];
      if (!c) throw new Error(`unknown chain "${name}" on ${network} (available: ${Object.keys(chains).join(", ")})`);
      if (c.kind === "evm") return { kind: "evm", name: c.name, label: c.label, chainId: c.chainId, symbol: c.symbol };
      if (c.kind === "btc") return { kind: "btc", name: c.name, label: c.label, network: c.network };
      return { kind: "sol", name: c.name, label: c.label, cluster: c.cluster };
    },
    chainNames: () => Object.keys(chains),
    evm: {
      async derive(account, path) {
        const k = `${account}|${path}`;
        let a = derived.get(k);
        if (!a) {
          const contract = new contracts.ChainSignatureContract({ networkId: network as any, contractId: signerContract });
          const evm = new chainAdapters.evm.EVM({ publicClient: {} as any, contract });
          a = (await evm.deriveAddressAndPublicKey(account, path)).address as `0x${string}`;
          derived.set(k, a);
        }
        return a;
      },
      balance: (c, address) => client(c).getBalance({ address }),
      erc20Balance: (c, token, owner) =>
        client(c).readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
      erc20Decimals: (c, token) => client(c).readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
      nonce: (c, address) => client(c).getTransactionCount({ address, blockTag: "pending" }),
      async fees(c) {
        const f = await client(c).estimateFeesPerGas();
        // Double the cap so a base-fee rise does not strand the transaction; only the real fee is charged.
        return { maxFeePerGas: f.maxFeePerGas * 2n, maxPriorityFeePerGas: f.maxPriorityFeePerGas };
      },
      async estimateGas(c, call) {
        try {
          return { gas: await client(c).estimateGas({ account: call.from, to: call.to, data: call.data, value: call.value }) };
        } catch (e: any) {
          return { revert: String(e.shortMessage ?? e.message).split("\n")[0] };
        }
      },
      async send(c, raw) {
        try {
          await client(c).sendRawTransaction({ serializedTransaction: raw });
        } catch (e: any) {
          // The same signed bytes may already be in the mempool or mined; the receipt poll decides.
          if (/already known|nonce too low|already imported|replacement/i.test(String(e.details ?? e.message))) return;
          throw e;
        }
      },
      async receipt(c, hash) {
        try {
          const r = await client(c).getTransactionReceipt({ hash });
          return { state: r.status, feePaid: r.gasUsed * r.effectiveGasPrice, blockNumber: r.blockNumber };
        } catch (e: any) {
          if (e.name === "TransactionReceiptNotFoundError") return { state: "pending" };
          throw e;
        }
      },
    },
    btc: btcEnv(network, signerContract),
    sol: solEnv(network, signerContract),
    intents: intentsEnv(),
  };
}

export function explorerUrl(network: string, chain: { kind: string; chainId?: number; name?: string }, hash: string): string | undefined {
  if (!isNetwork(network)) return undefined;
  if (chain.kind === "near") return NEAR_EXPLORER[network] + hash;
  const c = Object.values(CHAINS[network]).find((x) => (chain.kind === "evm" ? x.kind === "evm" && x.chainId === chain.chainId : x.name === chain.name));
  if (!c) return undefined;
  return typeof c.explorer === "function" ? c.explorer(hash) : c.explorer + hash;
}
