import { Connection, Message, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { chainAdapters, contracts } from "chainsig.js";
import type { Env, SolChain } from "../env.js";
import type { SolTxStep } from "../plan/types.js";
import { envVar } from "../portable.js";
import { CHAINS, type NetworkName, type SolDef } from "../registry.js";

/** Solana through Chain Signatures (ed25519, MPC domain 1). */
export function solEnv(network: NetworkName, signerContract: string): Env["sol"] {
  const defs = Object.values(CHAINS[network]).filter((c): c is SolDef => c.kind === "sol");
  const conns = new Map<string, Connection>();
  const conn = (c: SolChain): Connection => {
    let x = conns.get(c.name);
    if (!x) {
      const d = defs.find((y) => y.name === c.name)!;
      x = new Connection(envVar(d.rpcEnv) ?? d.rpc, "confirmed");
      conns.set(c.name, x);
    }
    return x;
  };
  const derived = new Map<string, string>();

  return {
    async derive(accountId, path) {
      const k = `${accountId}|${path}`;
      let a = derived.get(k);
      if (!a) {
        const contract = new contracts.ChainSignatureContract({ networkId: network as any, contractId: signerContract });
        const sol = new chainAdapters.solana.Solana({ solanaConnection: {} as any, contract });
        a = (await sol.deriveAddressAndPublicKey(accountId, path)).address;
        derived.set(k, a);
      }
      return a;
    },
    balance: async (c, address) => BigInt(await conn(c).getBalance(new PublicKey(address))),
    rentExempt: async (c) => BigInt(await conn(c).getMinimumBalanceForRentExemption(0)),

    async prepare(step: SolTxStep) {
      const { blockhash, lastValidBlockHeight } = await conn(step.chain).getLatestBlockhash("confirmed");
      const tx = new Transaction({ feePayer: new PublicKey(step.sender), blockhash, lastValidBlockHeight }).add(
        SystemProgram.transfer({ fromPubkey: new PublicKey(step.sender), toPubkey: new PublicKey(step.to), lamports: step.lamports }),
      );
      return { messageBase64: tx.serializeMessage().toString("base64"), blockhash, lastValidBlockHeight };
    },

    finalize(step, messageBase64, signature) {
      const tx = Transaction.populate(Message.from(Buffer.from(messageBase64, "base64")));
      tx.addSignature(new PublicKey(step.sender), Buffer.from(signature));
      if (!tx.verifySignatures()) throw new Error(`MPC signature does not verify against ${step.sender}; refusing to broadcast`);
      return { raw: tx.serialize().toString("base64"), txid: bs58.encode(signature) };
    },

    async send(c, raw) {
      try {
        await conn(c).sendRawTransaction(Buffer.from(raw, "base64"), { skipPreflight: false, maxRetries: 3 });
      } catch (e: any) {
        if (/already been processed|AlreadyProcessed/i.test(String(e.message))) return;
        throw e;
      }
    },

    async status(c, txid, lastValidBlockHeight) {
      const { value } = await conn(c).getSignatureStatuses([txid], { searchTransactionHistory: true });
      const s = value[0];
      if (s) {
        if (s.err) return { state: "failed", error: JSON.stringify(s.err), fee: 5000n };
        if (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized") return { state: "success", fee: 5000n };
        return { state: "pending" };
      }
      const height = await conn(c).getBlockHeight("confirmed");
      // A margin of 30 blocks so a transaction that landed at the very end is seen before we call it dead.
      return height > lastValidBlockHeight + 30 ? { state: "expired" } : { state: "pending" };
    },
  };
}
