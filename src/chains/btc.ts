import { secp256k1 } from "@noble/curves/secp256k1";
import * as bitcoin from "bitcoinjs-lib";
import { chainAdapters, contracts } from "chainsig.js";
import type { BtcPrepared, Env } from "../env.js";
import type { BtcTxStep } from "../plan/types.js";
import { envVar } from "../portable.js";
import { CHAINS, type BtcDef, type NetworkName } from "../registry.js";

const DUST = 546n;
const N = secp256k1.CURVE.n;

const netOf = (c: { network: "mainnet" | "testnet" }) => (c.network === "mainnet" ? bitcoin.networks.bitcoin : bitcoin.networks.testnet);

/** P2WPKH virtual size, rounded up: 10.5 + 68 per input + 31 per output. */
const vsize = (inputs: number, outputs: number) => BigInt(Math.ceil(10.5 + 68 * inputs + 31 * outputs));

/**
 * Pure: pick UTXOs (largest first: fewest inputs, fewest MPC signatures), pin the fee, build the
 * unsigned PSBT and capture each input's BIP-143 sighash.
 */
export function buildBtcTx(
  chain: { network: "mainnet" | "testnet" },
  utxos: { txid: string; vout: number; value: number }[],
  rate: bigint,
  req: { from: string; publicKey: string; to: string; amount: bigint },
): BtcPrepared {
  const network = netOf(chain);
  const sorted = [...utxos].sort((a, b) => b.value - a.value);
  const picked: typeof utxos = [];
  let total = 0n;
  let fee = 0n;
  for (const u of sorted) {
    picked.push(u);
    total += BigInt(u.value);
    fee = vsize(picked.length, 2) * rate;
    if (total >= req.amount + fee) break;
  }
  if (!picked.length) fee = vsize(1, 2) * rate;
  if (total < req.amount + fee) {
    throw new Error(`${req.from} has ${total} sats in ${utxos.length} UTXO(s); ${req.amount} + fee ${fee} sats needed`);
  }
  let change = total - req.amount - fee;
  if (change < DUST) {
    fee += change; // too small to keep: it goes to the miner
    change = 0n;
  }
  const script = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(req.publicKey, "hex"), network }).output!;
  const psbt = new bitcoin.Psbt({ network });
  for (const u of picked) psbt.addInput({ hash: u.txid, index: u.vout, witnessUtxo: { script, value: u.value } });
  psbt.addOutput({ address: req.to, value: Number(req.amount) });
  if (change > 0n) psbt.addOutput({ address: req.from, value: Number(change) });
  const psbtHex = psbt.toHex();
  const hashes: string[] = [];
  for (let i = 0; i < psbt.inputCount; i++) {
    psbt.signInput(i, {
      publicKey: Buffer.from(req.publicKey, "hex"),
      sign: (h: Buffer) => {
        hashes[i] = h.toString("hex");
        return Buffer.alloc(64, 1);
      },
    });
  }
  return { psbtHex, hashes, inputs: picked.map((u) => ({ txid: u.txid, vout: u.vout, value: BigInt(u.value) })), fee };
}

/** Esplora (Blockstream / mempool.space) client + PSBT handling for Chain Signatures P2WPKH addresses. */
export function btcEnv(network: NetworkName, signerContract: string): Env["btc"] {
  const defs = Object.values(CHAINS[network]).filter((c): c is BtcDef => c.kind === "btc");
  const api = (name: string) => {
    const d = defs.find((x) => x.name === name)!;
    return (envVar(d.apiEnv) ?? d.api).replace(/\/$/, "");
  };
  const get = async (name: string, path: string): Promise<Response> => {
    const r = await fetch(`${api(name)}${path}`, { signal: AbortSignal.timeout(20_000) });
    return r;
  };
  const json = async (name: string, path: string): Promise<any> => {
    const r = await get(name, path);
    if (!r.ok) throw new Error(`Bitcoin API ${path}: HTTP ${r.status} ${await r.text()}`);
    return r.json();
  };
  const derived = new Map<string, { address: string; publicKey: string }>();
  const btcNet = network === "mainnet" ? "mainnet" : "testnet";

  return {
    async derive(accountId, path) {
      const k = `${accountId}|${path}`;
      let d = derived.get(k);
      if (!d) {
        const contract = new contracts.ChainSignatureContract({ networkId: network as any, contractId: signerContract });
        const adapter = new chainAdapters.btc.Bitcoin({ network: btcNet, contract, btcRpcAdapter: {} as any });
        d = await adapter.deriveAddressAndPublicKey(accountId, path);
        derived.set(k, d);
      }
      return d;
    },

    async balance(chain, address) {
      const a = await json(chain.name, `/address/${address}`);
      const c = a.chain_stats, m = a.mempool_stats;
      return BigInt(c.funded_txo_sum - c.spent_txo_sum + m.funded_txo_sum - m.spent_txo_sum);
    },

    async prepare(chain, req): Promise<BtcPrepared> {
      const utxos: { txid: string; vout: number; value: number }[] = await json(chain.name, `/address/${req.from}/utxo`);
      const fees: Record<string, number> = await json(chain.name, "/fee-estimates");
      const rate = BigInt(Math.max(1, Math.ceil((fees["6"] ?? fees["3"] ?? 2) + 1)));
      return buildBtcTx(chain, utxos, rate, req);
    },

    finalize(step: BtcTxStep, signatures: string[]) {
      const psbt = bitcoin.Psbt.fromHex(step.psbtHex, { network: netOf(step.chain) });
      const pub = Buffer.from(step.publicKey, "hex");
      signatures.forEach((sigHex, i) => {
        let r = BigInt(`0x${sigHex.slice(0, 64)}`);
        let s = BigInt(`0x${sigHex.slice(64)}`);
        if (s > N / 2n) s = N - s; // Bitcoin relays only low-S signatures; (r, n-s) is equally valid.
        const sig = Buffer.from(r.toString(16).padStart(64, "0") + s.toString(16).padStart(64, "0"), "hex");
        if (!secp256k1.verify(sig, Buffer.from(step.hashes[i], "hex"), pub)) {
          throw new Error(`MPC signature for input ${i + 1} does not verify against ${step.sender}; refusing to broadcast`);
        }
        psbt.signInput(i, { publicKey: pub, sign: () => sig });
      });
      const ok = psbt.validateSignaturesOfAllInputs((pk, msg, sig) => secp256k1.verify(sig, msg, pk));
      if (!ok) throw new Error("signed Bitcoin transaction does not validate; refusing to broadcast");
      psbt.finalizeAllInputs();
      const tx = psbt.extractTransaction();
      return { raw: tx.toHex(), txid: tx.getId() };
    },

    async send(chain, raw) {
      const r = await fetch(`${api(chain.name)}/tx`, { method: "POST", body: raw, signal: AbortSignal.timeout(20_000) });
      if (r.ok) return;
      const text = await r.text();
      // The same bytes are already known: the status poll decides.
      if (/already|txn-already-known|known/i.test(text)) return;
      throw new Error(`Bitcoin broadcast rejected: ${text}`);
    },

    async status(chain, txid) {
      const r = await get(chain.name, `/tx/${txid}/status`);
      if (r.status === 404) return "unknown";
      if (!r.ok) throw new Error(`Bitcoin API status: HTTP ${r.status}`);
      const s: any = await r.json();
      return s.confirmed ? "confirmed" : "mempool";
    },
  };
}
