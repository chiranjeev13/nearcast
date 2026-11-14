import { chainAdapters } from "chainsig.js";
import {
  encodeFunctionData,
  getAddress,
  isAddress,
  keccak256,
  parseAbiItem,
  recoverTransactionAddress,
  type AbiFunction,
  type AbiParameter,
} from "viem";
import { asInt, show } from "../plan/eval.js";
import type { EvmTxStep, Value } from "../plan/types.js";

// Serialization and signature assembly come from NEAR's chainsig.js. These two methods are pure,
// so the adapter is built without a client; all network access goes through our own Env.
const adapter = new chainAdapters.evm.EVM({ publicClient: {} as any, contract: {} as any });

export interface MpcSignature {
  big_r: { affine_point: string };
  s: { scalar: string };
  recovery_id: number;
}

function unsigned(step: EvmTxStep) {
  return {
    type: "eip1559" as const,
    chainId: step.chain.chainId,
    nonce: step.nonce,
    to: step.to,
    data: step.data,
    value: step.value,
    gas: step.gas,
    maxFeePerGas: step.maxFeePerGas,
    maxPriorityFeePerGas: step.maxPriorityFeePerGas,
  };
}

/** The 32-byte hash the MPC network signs. Fully determined by the frozen plan. */
export function signingHash(step: EvmTxStep): `0x${string}` {
  return keccak256(adapter.serializeTransaction(unsigned(step) as any));
}

/** Attach the MPC signature and prove it recovers to the planned sender before anything is broadcast. */
export async function finalize(step: EvmTxStep, sig: MpcSignature): Promise<{ raw: `0x${string}`; hash: `0x${string}` }> {
  if (!sig?.big_r?.affine_point || !sig?.s?.scalar || typeof sig.recovery_id !== "number") {
    throw new Error(`unexpected MPC signature shape: ${JSON.stringify(sig)}`);
  }
  let raw: `0x${string}`;
  let from: string;
  try {
    raw = adapter.finalizeTransactionSigning({
      transaction: unsigned(step) as any,
      rsvSignatures: [{ r: sig.big_r.affine_point.slice(2), s: sig.s.scalar, v: sig.recovery_id + 27 }],
    }) as `0x${string}`;
    from = await recoverTransactionAddress({ serializedTransaction: raw as any });
  } catch (e) {
    throw new Error(`MPC signature is not valid for this transaction (${(e as Error).message}); refusing to broadcast`);
  }
  if (from.toLowerCase() !== step.sender.toLowerCase()) {
    throw new Error(`MPC signature recovers to ${from}, expected ${step.sender}; refusing to broadcast`);
  }
  return { raw, hash: keccak256(raw) };
}

function coerce(p: AbiParameter, v: Value, where: string): unknown {
  const t = p.type;
  const arr = /^(.*)\[\d*\]$/.exec(t);
  if (arr) {
    if (!Array.isArray(v)) throw new Error(`${where}: expected a list for ${t}`);
    return v.map((x, i) => coerce({ ...p, type: arr[1] } as AbiParameter, x, `${where}[${i}]`));
  }
  if (t === "tuple") {
    if (!Array.isArray(v)) throw new Error(`${where}: expected a list for tuple`);
    const comps = (p as any).components as AbiParameter[];
    return comps.map((c, i) => coerce(c, v[i], `${where}.${i}`));
  }
  if (/^u?int/.test(t)) return asInt(v, where);
  if (t === "address") {
    if (typeof v !== "string" || !isAddress(v, { strict: false })) throw new Error(`${where}: expected an EVM address, got ${show(v)}`);
    return getAddress(v);
  }
  if (t === "bool") {
    if (typeof v !== "boolean") throw new Error(`${where}: expected true or false, got ${show(v)}`);
    return v;
  }
  if (t === "string") return typeof v === "string" ? v : show(v);
  if (/^bytes/.test(t)) {
    if (typeof v !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(v)) throw new Error(`${where}: expected 0x-prefixed bytes, got ${show(v)}`);
    return v;
  }
  throw new Error(`${where}: unsupported ABI type ${t}`);
}

export function encodeCall(signature: string, args: Value[]): { data: `0x${string}`; args: unknown[]; decoded: string; fn: AbiFunction } {
  let fn: AbiFunction;
  try {
    fn = parseAbiItem(`function ${signature}`) as AbiFunction;
  } catch {
    throw new Error(`bad function signature "${signature}" (expected e.g. "transfer(address,uint256)")`);
  }
  if (fn.inputs.length !== args.length) {
    throw new Error(`${signature} takes ${fn.inputs.length} argument(s), got ${args.length}`);
  }
  const coerced = fn.inputs.map((p, i) => coerce(p, args[i], `argument ${i + 1} of ${fn.name}`));
  const data = encodeFunctionData({ abi: [fn], functionName: fn.name, args: coerced });
  const render = (x: unknown): string => (Array.isArray(x) ? `[${x.map(render).join(", ")}]` : String(x));
  const decoded = `${fn.name}(${fn.inputs.map((p, i) => `${p.type} ${render(coerced[i])}`).join(", ")})`;
  return { data, args: coerced, decoded, fn };
}
