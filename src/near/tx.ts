import { createHash } from "node:crypto";
import { KeyPair, PublicKey } from "@near-js/crypto";
import {
  actionCreators,
  buildDelegateAction,
  createTransaction,
  encodeDelegateAction,
  encodeSignedDelegate,
  encodeTransaction,
  GlobalContractDeployMode,
  GlobalContractIdentifier,
  SCHEMA,
  Signature,
  SignedTransaction,
  type Action,
} from "@near-js/transactions";
import { baseDecode, baseEncode } from "@near-js/utils";
import { deserialize } from "borsh";
import type { NearAction } from "../plan/types.js";

export interface SignedNearTx {
  /** base58 tx hash - known before broadcast, which is what makes resume safe. */
  hash: string;
  base64: string;
  nonce: bigint;
  blockHash: string;
  /** Public key that signed (needed to check the nonce later). */
  publicKey: string;
}

/** Facts read from the chain right before signing a delegate. */
export interface DelegateContext {
  nonce: bigint;
  maxBlockHeight: bigint;
}

const sha256 = (b: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(b).digest());

/** Plan action -> protocol action. `delegate` needs the sender's key, so it goes through NearSigner. */
export function toProtocolAction(a: NearAction): Action {
  switch (a.kind) {
    case "call":
      return actionCreators.functionCall(a.method, Buffer.from(JSON.stringify(a.args)), a.gas, a.deposit);
    case "transfer":
      return actionCreators.transfer(a.deposit);
    case "create-account":
      return actionCreators.createAccount();
    case "delete-account":
      return actionCreators.deleteAccount(a.beneficiary);
    case "add-key":
      return actionCreators.addKey(
        PublicKey.fromString(a.publicKey),
        a.permission === "full"
          ? actionCreators.fullAccessKey()
          : actionCreators.functionCallAccessKey(a.permission.receiver, a.permission.methods, a.permission.allowance ?? undefined),
      );
    case "delete-key":
      return actionCreators.deleteKey(PublicKey.fromString(a.publicKey));
    case "deploy":
      return actionCreators.deployContract(Buffer.from(a.codeBase64, "base64"));
    case "deploy-global":
      return actionCreators.deployGlobalContract(
        Buffer.from(a.codeBase64, "base64"),
        new GlobalContractDeployMode(a.mode === "hash" ? { CodeHash: null } : { AccountId: null }),
      );
    case "use-global":
      return actionCreators.useGlobalContract(
        new GlobalContractIdentifier("hash" in a.ref ? { CodeHash: baseDecode(a.ref.hash) } : { AccountId: a.ref.account }),
      );
    case "stake":
      return actionCreators.stake(a.amount, PublicKey.fromString(a.publicKey));
    case "signed-delegate": {
      const sd = decodeSignedDelegate(a.base64);
      return actionCreators.signedDelegate(sd as any);
    }
    case "delegate":
      throw new Error("internal: a delegate action must be signed by its sender first");
  }
}

/** Decode a base64 borsh SignedDelegate. Throws on anything else. */
export function decodeSignedDelegate(base64: string): {
  delegateAction: { senderId: string; receiverId: string; actions: any[]; nonce: bigint; maxBlockHeight: bigint; publicKey: any };
  signature: any;
} {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, "base64");
    const sd = deserialize(SCHEMA.SignedDelegate, bytes) as any;
    if (!sd?.delegateAction?.senderId) throw new Error("missing sender");
    return sd;
  } catch (e) {
    throw new Error(`not a valid signed delegate action (base64 borsh): ${(e as Error).message}`);
  }
}

/** Plain-language summary of an already-signed delegate, for the plan. */
export function describeSignedDelegate(base64: string): { sender: string; receiver: string; actions: string[]; maxBlockHeight: bigint } {
  const sd = decodeSignedDelegate(base64);
  const d = sd.delegateAction;
  const actions = d.actions.map((x: any) => {
    const [k, v] = Object.entries(x).find(([, val]) => val !== undefined) as [string, any];
    if (k === "functionCall") {
      return `${v.methodName}(${Buffer.from(v.args).toString().slice(0, 200)}) deposit ${v.deposit} yocto, gas ${v.gas}`;
    }
    if (k === "transfer") return `transfer ${v.deposit} yoctoNEAR`;
    return k;
  });
  return { sender: d.senderId, receiver: d.receiverId, actions, maxBlockHeight: BigInt(d.maxBlockHeight) };
}

/** Wraps a key. The secret never leaves this object and is never stringified. */
export class NearSigner {
  readonly #keyPair: KeyPair;
  constructor(
    readonly accountId: string,
    secretKey: string,
  ) {
    this.#keyPair = KeyPair.fromString(secretKey as any);
  }
  get publicKey(): string {
    return this.#keyPair.getPublicKey().toString();
  }
  toJSON() {
    return { accountId: this.accountId, publicKey: this.publicKey };
  }

  /** NEP-366: sign a DelegateAction for `receiver`. Returns the borsh SignedDelegate (base64). */
  signDelegate(receiver: string, actions: NearAction[], ctx: DelegateContext): string {
    const da = buildDelegateAction({
      senderId: this.accountId,
      receiverId: receiver,
      actions: actions.map(toProtocolAction),
      nonce: ctx.nonce,
      maxBlockHeight: ctx.maxBlockHeight,
      publicKey: this.#keyPair.getPublicKey(),
    } as any);
    const { signature } = this.#keyPair.sign(sha256(encodeDelegateAction(da)));
    const sd = { delegateAction: da, signature: new Signature({ keyType: 0, data: signature }) };
    return Buffer.from(encodeSignedDelegate(sd as any)).toString("base64");
  }

  /**
   * Build and sign locally. Nothing is sent. The nonce is fixed here, once.
   * `delegates` resolves each `delegate` action by having its sender sign it.
   */
  sign(receiver: string, actions: Action[], nonce: bigint, blockHash: string): SignedNearTx {
    const tx = createTransaction(this.accountId, this.#keyPair.getPublicKey(), receiver, nonce, actions, baseDecode(blockHash));
    const digest = sha256(encodeTransaction(tx));
    const { signature } = this.#keyPair.sign(digest);
    const signed = new SignedTransaction({
      transaction: tx,
      signature: new Signature({ keyType: tx.publicKey.keyType, data: signature }),
    });
    return {
      hash: baseEncode(digest),
      base64: Buffer.from(signed.encode()).toString("base64"),
      nonce,
      blockHash,
      publicKey: this.publicKey,
    };
  }
}

/** A fresh ed25519 key pair, as near-cli stores it. */
export function newKeyPair(): { publicKey: string; secretKey: string } {
  const kp = KeyPair.fromRandom("ed25519");
  return { publicKey: kp.getPublicKey().toString(), secretKey: kp.toString() };
}

export function isPublicKey(s: string): boolean {
  try {
    PublicKey.fromString(s);
    return /^(ed25519|secp256k1):/.test(s);
  } catch {
    return false;
  }
}
