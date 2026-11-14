import { ed25519 } from "@noble/curves/ed25519";
import { secp256k1 } from "@noble/curves/secp256k1";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import * as bitcoin from "bitcoinjs-lib";
import { describe, expect, it } from "vitest";
import { buildBtcTx, btcEnv } from "../src/chains/btc.js";
import { solEnv } from "../src/chains/sol.js";
import { buildDocs } from "../src/docs.js";
import { memoryStore, newCheckpoint } from "../src/exec/checkpoint.js";
import { execute, type ExecOptions } from "../src/exec/executor.js";
import { MODULES } from "../src/modules/index.js";
import { describeSignedDelegate, newKeyPair, NearSigner, toProtocolAction } from "../src/near/tx.js";
import { plan } from "../src/plan/planner.js";
import type { BtcTxStep, DelegateSignStep, NearTxStep, SolTxStep } from "../src/plan/types.js";
import { renderPlan } from "../src/render.js";
import { toWalletActions } from "../src/ui/server.js";
import { planView } from "../src/ui/view.js";
import { fakeEnv, ME } from "./fake.js";

const NEAR = 10n ** 24n;
const FAST: ExecOptions = { pollMs: 1, timeoutMs: 30, unknownGrace: 2, sleep: async () => {} };
const KEY = "ed25519:GnRLkCws5rbcpmcxqAawMQjaoNeojB57JQAz8KYq6dWk";
const near = (p: { steps: unknown[] }, i: number) => p.steps[i] as NearTxStep;
const acts = (s: NearTxStep) => s.actions as any[];

async function run(src: string, env = fakeEnv(), opts: ExecOptions = {}) {
  const p = await plan(src, env);
  const store = memoryStore();
  const cp = newCheckpoint(p);
  store.save(cp);
  const out = await execute(cp, env, store, { ...FAST, ...opts });
  return { env, p, cp, out, store };
}

describe("native NEAR actions", () => {
  it("transfer: bare numbers are NEAR, unit literals are exact", async () => {
    const p = await plan("transfer bob.testnet 1.5\ntransfer bob.testnet 1near\ntransfer bob.testnet 500yocto", fakeEnv());
    expect(p.steps.map((s) => acts(s as NearTxStep)[0])).toMatchObject([
      { kind: "transfer", deposit: 15n * 10n ** 23n },
      { kind: "transfer", deposit: NEAR },
      { kind: "transfer", deposit: 500n },
    ]);
  });

  it("transfer to a missing named account is blocked; to an implicit account it creates it", async () => {
    const env = fakeEnv();
    env.missing.add("ghost.testnet");
    env.missing.add("ab".repeat(32));
    const p = await plan(`transfer ghost.testnet 1\ntransfer ${"ab".repeat(32)} 1`, env);
    expect(p.checks.some((c) => c.level === "fail" && /ghost.testnet does not exist/.test(c.description))).toBe(true);
    expect(near(p, 1).description).toContain("creates this implicit account");
  });

  it("account:create a sub-account: create + fund + key in one atomic transaction, key saved locally", async () => {
    const p = await plan("load account\naccount:create new.me.testnet --deposit 2", fakeEnv());
    const s = near(p, 0);
    expect(s.receiver).toBe("new.me.testnet");
    expect(s.atomic).toBe(true);
    expect(acts(s).map((a) => a.kind)).toEqual(["create-account", "transfer", "add-key"]);
    expect(acts(s)[1].deposit).toBe(2n * NEAR);
    expect(p.checks.some((c) => /generated and saved to \/keys\/new.me.testnet.json/.test(c.description))).toBe(true);
  });

  it("account:create a top-level account goes through the registrar", async () => {
    const p = await plan(`load account\naccount:create newtop.testnet --key ${KEY}`, fakeEnv());
    expect(near(p, 0).receiver).toBe("testnet");
    expect(acts(near(p, 0))[0]).toMatchObject({ kind: "call", method: "create_account", args: { new_account_id: "newtop.testnet", new_public_key: KEY } });
    await expect(plan("load account\naccount:create newx.other.testnet", fakeEnv())).rejects.toThrow(/sub-account of the signer/);
  });

  it("account:delete is dangerous, needs a beneficiary, and nothing may follow from that account", async () => {
    await expect(plan("load account\naccount:delete", fakeEnv())).rejects.toThrow(/--beneficiary/);
    const p = await plan("load account\naccount:delete --beneficiary bob.testnet", fakeEnv());
    expect((near(p, 0) as any).danger).toMatch(/permanently/);
    expect(planView(p).steps[0].risk).toContain("irreversible");
    await expect(plan("load account\naccount:delete --beneficiary bob.testnet\ntransfer bob.testnet 1", fakeEnv())).rejects.toThrow(/deleted by an earlier step/);
  });

  it("add-key: full access is flagged; function-call keys carry receiver, methods, allowance", async () => {
    const p = await plan(`load account
account:add-key ${KEY}
account:add-key ${KEY} --contract game.testnet --methods "play,claim" --allowance 0.5`, fakeEnv());
    expect((near(p, 0) as any).danger).toMatch(/fully controls/);
    expect(acts(near(p, 1))[0].permission).toEqual({ receiver: "game.testnet", methods: ["play", "claim"], allowance: 5n * 10n ** 23n });
  });

  it("delete-key refuses to lock the account by deleting its only full-access key", async () => {
    const p = await plan(`load account\naccount:delete-key ${KEY}`, fakeEnv());
    expect(p.checks.some((c) => c.level === "fail" && /only full-access key/.test(c.description))).toBe(true);
  });

  it("deploy + init is one atomic transaction and locks storage; replacing code is flagged", async () => {
    const env = fakeEnv();
    env.codeHash.set(ME, "SomeOtherCodeHash1111111111111111111111111");
    const p = await plan('load account\naccount:deploy ./c.wasm --init new --args {"owner": "me.testnet"}', env);
    const s = near(p, 0);
    expect(acts(s).map((a) => a.kind)).toEqual(["deploy", "call"]);
    expect(s.atomic).toBe(true);
    expect((s as any).danger).toMatch(/replaces the contract/);
    expect(p.checks[0].description).toMatch(/locked balance/);
    await expect(plan("load account\naccount:deploy ./nope.txt", fakeEnv())).rejects.toThrow(/no such file/);
  });

  it("staking: pool deposit and native stake", async () => {
    const p = await plan(`load stake\nstake:deposit pool.testnet 1\nstake:unstake pool.testnet all\nstake:native 0 ${KEY}`, fakeEnv());
    expect(acts(near(p, 0))[0]).toMatchObject({ method: "deposit_and_stake", deposit: NEAR });
    expect(acts(near(p, 1))[0]).toMatchObject({ method: "unstake_all" });
    expect(acts(near(p, 2))[0]).toMatchObject({ kind: "stake", amount: 0n, publicKey: KEY });
  });

  it("as ( ... ) signs with another local key; unknown accounts are refused", async () => {
    const { env, out, p } = await run("as app.me.testnet (\n  transfer bob.testnet 1\n)");
    expect(near(p, 0).sender).toBe("app.me.testnet");
    expect(out.kind).toBe("done");
    expect(env.calls.some((c) => c.endsWith("by app.me.testnet"))).toBe(true);
    await expect(plan("as stranger.testnet (\n  transfer bob.testnet 1\n)", fakeEnv())).rejects.toThrow(/no local key for stranger.testnet/);
  });
});

describe("tokens, NFTs", () => {
  it("token:wrap registers first if needed; nft:transfer attaches 1 yocto", async () => {
    const env = fakeEnv();
    const p = await plan("load token\nload nft\ntoken:wrap 1\nnft:transfer nft.testnet 42 bob.testnet", env);
    expect(acts(near(p, 0)).map((a) => a.method)).toEqual(["near_deposit"]);
    expect(acts(near(p, 1))[0]).toMatchObject({ method: "nft_transfer", deposit: 1n, args: { receiver_id: "bob.testnet", token_id: "42" } });
  });
});

describe("meta transactions (NEP-366)", () => {
  it("meta:relay: the relayer sends a delegate action from the script account", async () => {
    const { p, env, out } = await run("load meta\nmeta:relay --relayer relayer.testnet (\n  call counter.testnet increment\n  call counter.testnet increment\n)");
    const s = near(p, 0);
    expect(s).toMatchObject({ sender: "relayer.testnet", receiver: ME });
    expect(acts(s)[0]).toMatchObject({ kind: "delegate", sender: ME, receiver: "counter.testnet" });
    expect(acts(s)[0].actions).toHaveLength(2);
    expect(out.kind).toBe("done");
    expect(env.calls.some((c) => c.endsWith("by relayer.testnet"))).toBe(true);
  });

  it("meta:sign produces a signed delegate and sends nothing", async () => {
    const { p, cp, env, out } = await run("load meta\nmeta:sign (\n  transfer bob.testnet 1\n)");
    expect((p.steps[0] as DelegateSignStep).type).toBe("delegate-sign");
    expect(out.kind).toBe("done");
    expect((cp.state.s1.result as any).signedDelegate).toBeTruthy();
    expect(env.calls.some((c) => c.startsWith("near.broadcast"))).toBe(false);
  });

  it("meta blocks keep one receiver; relayers need keys", async () => {
    await expect(plan("load meta\nmeta:relay --relayer relayer.testnet (\n  call a.testnet x\n  call b.testnet y\n)", fakeEnv())).rejects.toThrow(/cannot contain an action on b.testnet/);
    await expect(plan("load meta\nmeta:relay --relayer nokey.testnet (\n  call a.testnet x\n)", fakeEnv())).rejects.toThrow(/no local key/);
  });

  it("real keys: a signed delegate round-trips and becomes a relayable action", () => {
    const kp = newKeyPair();
    const signer = new NearSigner("alice.testnet", kp.secretKey);
    const b64 = signer.signDelegate("counter.testnet", [{ kind: "call", method: "increment", args: {}, deposit: 0n, gas: 10n ** 13n, decoded: "" }], { nonce: 5n, maxBlockHeight: 123n });
    const d = describeSignedDelegate(b64);
    expect(d).toMatchObject({ sender: "alice.testnet", receiver: "counter.testnet", maxBlockHeight: 123n });
    expect(d.actions[0]).toMatch(/^increment\(\{\}\)/);
    const action = toProtocolAction({ kind: "signed-delegate", base64: b64, sender: "alice.testnet", receiver: "counter.testnet", decoded: "" });
    const tx = new NearSigner("relayer.testnet", newKeyPair().secretKey).sign("alice.testnet", [action], 1n, "11111111111111111111111111111111");
    expect(tx.hash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    expect(() => describeSignedDelegate("bm90IGEgZGVsZWdhdGU=")).toThrow(/not a valid signed delegate/);
  });
});

describe("Chain Signatures beyond one EVM call", () => {
  it("chainsig:transfer on an EVM chain is a plain value transfer", async () => {
    const p = await plan('load chainsig\nchainsig:transfer base "t" 0x000000000000000000000000000000000000dEaD 0.001', fakeEnv());
    expect(p.steps[1]).toMatchObject({ type: "evm-tx", value: 10n ** 15n, data: "0x" });
  });

  it("Bitcoin: one MPC signature per input, then one broadcast", async () => {
    const { p, out, env, cp } = await run('load chainsig\nchainsig:transfer bitcoin "vault" tb1qrecipient 0.0001');
    expect(p.steps.map((s) => s.type)).toEqual(["near-tx", "near-tx", "btc-tx"]);
    const btc = p.steps[2] as BtcTxStep;
    expect(btc).toMatchObject({ amount: 10_000n, fee: 500n, signedBy: ["s1", "s2"] });
    expect(acts(near(p, 0))[0].args.request).toEqual({ payload_v2: { Ecdsa: "aa".repeat(32) }, path: "vault", domain_id: 0 });
    expect(out.kind).toBe("done");
    expect(env.calls).toContain("btc.finalize 2");
    expect(cp.state.s3.status).toBe("confirmed");
    await expect(plan('load chainsig\nchainsig:transfer bitcoin "v" tb1qx 0.0001\nchainsig:transfer bitcoin "v" tb1qy 0.0001', fakeEnv())).rejects.toThrow(/one Bitcoin payment per address/);
  });

  it("Solana: the message is built right before signing and signed with ed25519", async () => {
    const { p, out, env, cp } = await run('load chainsig\nchainsig:transfer solana "s" So1Recipient111111111111111111111111111111 0.01');
    const sign = near(p, 0);
    expect(sign.purpose).toMatchObject({ late: true, scheme: "ed25519" });
    expect(acts(sign)[0].args.request.domain_id).toBe(1);
    expect(out.kind).toBe("done");
    expect(env.eddsaPayloads).toEqual([Buffer.from("msg-1").toString("hex")]);
    expect((cp.state.s2 as any).prepared.blockhash).toBe("bh1");
    expect((p.steps[1] as SolTxStep).lamports).toBe(10_000_000n);
  });

  it("Solana: an expired transaction is rebuilt and signed again, never sent twice", async () => {
    const env = fakeEnv();
    let first = true;
    env.solStatus = (txid) => {
      if (txid === "soltx-msg-1" && first) {
        first = false;
        return { state: "expired" };
      }
      return { state: "success", fee: 5000n };
    };
    const { out, cp } = await run('load chainsig\nchainsig:transfer solana "s" So1Recipient111111111111111111111111111111 0.01', env);
    expect(out.kind).toBe("done");
    expect(env.solPrepares).toBe(2);
    expect(env.eddsaPayloads).toHaveLength(2);
    expect(cp.state.s2.txHash).toBe("soltx-msg-2");
  });

  it("Solana: sending less than rent exemption to an empty account is blocked", async () => {
    const env = fakeEnv();
    env.sol.balance = async (_c, a) => (a.startsWith("So1Fake") ? 10n ** 9n : 0n);
    const p = await plan('load chainsig\nchainsig:transfer solana "s" So1Empty1111111111111111111111111111111111 0.0001', env);
    expect(p.checks.some((c) => c.level === "fail" && /rent exemption/.test(c.description))).toBe(true);
  });
});

describe("real signing math (no network)", () => {
  it("Bitcoin: sighashes from buildBtcTx, signed with a local key, finalize into a valid transaction", () => {
    const priv = secp256k1.utils.randomPrivateKey();
    const pub = Buffer.from(secp256k1.getPublicKey(priv, true)).toString("hex");
    const network = bitcoin.networks.testnet;
    const from = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(pub, "hex"), network }).address!;
    const to = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(secp256k1.getPublicKey(secp256k1.utils.randomPrivateKey(), true)), network }).address!;
    const prep = buildBtcTx({ network: "testnet" }, [
      { txid: "11".repeat(32), vout: 0, value: 6_000 },
      { txid: "22".repeat(32), vout: 1, value: 9_000 },
    ], 2n, { from, publicKey: pub, to, amount: 12_000n });
    expect(prep.inputs).toHaveLength(2);
    expect(prep.fee).toBe(BigInt(Math.ceil(10.5 + 68 * 2 + 31 * 2)) * 2n);
    const step = {
      id: "s3", index: 2, type: "btc-tx", chain: { kind: "btc", name: "bitcoin", label: "Bitcoin testnet", network: "testnet" },
      sender: from, publicKey: pub, to, amount: 12_000n, ...prep,
    } as unknown as BtcTxStep;
    // What the MPC network returns: r || s. Use a high-S form for one input to prove normalization.
    const sigs = prep.hashes.map((h, i) => {
      const sig = secp256k1.sign(h, priv);
      const s = i === 1 ? secp256k1.CURVE.n - sig.s : sig.s;
      return sig.r.toString(16).padStart(64, "0") + s.toString(16).padStart(64, "0");
    });
    const env = btcEnv("testnet", "v1.signer-prod.testnet");
    const { raw, txid } = env.finalize(step, sigs);
    const tx = bitcoin.Transaction.fromHex(raw);
    expect(tx.getId()).toBe(txid);
    expect(tx.ins).toHaveLength(2);
    expect(tx.outs[0].value).toBe(12_000);
    // A signature from another key is refused before anything could be broadcast.
    const bad = prep.hashes.map((h) => Buffer.from(secp256k1.sign(h, secp256k1.utils.randomPrivateKey()).toCompactRawBytes()).toString("hex"));
    expect(() => env.finalize(step, bad)).toThrow(/does not verify/);
  });

  it("Solana: an ed25519 signature over the prepared message finalizes into a verified transaction", () => {
    const kp = Keypair.generate();
    const to = Keypair.generate().publicKey;
    const tx = new Transaction({ feePayer: kp.publicKey, blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 10 }).add(
      SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: to, lamports: 1000 }),
    );
    const msg = tx.serializeMessage();
    const sig = ed25519.sign(msg, kp.secretKey.slice(0, 32));
    const step = { sender: kp.publicKey.toBase58(), to: to.toBase58(), lamports: 1000n, chain: { kind: "sol", name: "solana" } } as unknown as SolTxStep;
    const env = solEnv("testnet", "v1.signer-prod.testnet");
    const { raw, txid } = env.finalize(step, msg.toString("base64"), sig);
    expect(Transaction.from(Buffer.from(raw, "base64")).verifySignatures()).toBe(true);
    expect(new PublicKey(kp.publicKey).toBase58()).toBe(step.sender);
    expect(txid.length).toBeGreaterThan(80);
    expect(() => env.finalize(step, msg.toString("base64"), ed25519.sign(msg, Keypair.generate().secretKey.slice(0, 32)))).toThrow(/does not verify/);
  });
});

describe("wallet mode", () => {
  const walletEnv = () => {
    const env = fakeEnv();
    env.keyAccounts.delete(ME); // the script account is the wallet's
    return env;
  };

  it("the wallet signs and sends; the executor records the hash and polls it", async () => {
    const env = walletEnv();
    const seen: string[] = [];
    const { out, cp } = await run("transfer bob.testnet 1", env, {
      wallet: async (step, actions) => {
        seen.push(`${step.sender}->${step.receiver}:${actions[0].kind}`);
        // Pretend the wallet broadcast it: the fake network accepts a hash it has seen signed.
        const tx = await env.near.signTx(step.sender, step.receiver, actions);
        await env.near.broadcast(tx.base64);
        return { txHash: tx.hash };
      },
    });
    expect(seen).toEqual(["me.testnet->bob.testnet:transfer"]);
    expect(out.kind).toBe("done");
    expect(cp.state.s1).toMatchObject({ status: "confirmed" });
    expect(cp.state.s1.handoff).toBeUndefined();
  });

  it("a rejected wallet request fails the step and says nothing was sent", async () => {
    const { out } = await run("transfer bob.testnet 1", walletEnv(), { wallet: async () => ({ error: "User rejected" }) });
    expect(out).toMatchObject({ kind: "failed", error: "wallet: User rejected (nothing was sent)" });
  });

  it("a crash while the wallet is open leaves a handoff that only a human can resolve", async () => {
    const env = walletEnv();
    const p = await plan("transfer bob.testnet 1", env);
    const store = memoryStore();
    const cp = newCheckpoint(p);
    store.save(cp);
    await expect(execute(cp, env, store, { ...FAST, wallet: () => Promise.reject(new Error("killed")) })).rejects.toThrow("killed");
    const again = store.load()!;
    expect(again.state.s1.handoff).toBeTruthy();
    const out = await execute(again, env, store, { ...FAST, wallet: async () => ({ txHash: "never" }) });
    expect(out).toMatchObject({ kind: "waiting", handoff: true });
    expect(planView(again.plan, again.state, () => false).steps[0].hint).toMatch(/wallet answer not recorded/);
  });

  it("wallet actions use Wallet Selector's shape; unsupported actions are refused", () => {
    expect(toWalletActions([
      { kind: "call", method: "m", args: { a: 1 }, deposit: 1n, gas: 30n * 10n ** 12n, decoded: "" },
      { kind: "transfer", deposit: NEAR, decoded: "" },
      { kind: "add-key", publicKey: KEY, permission: { receiver: "c.testnet", methods: [], allowance: 5n }, decoded: "" },
      { kind: "deploy", codeBase64: "AGFzbQEAAAA=", sha256: "x", size: 8, decoded: "" },
    ])).toEqual([
      { type: "FunctionCall", params: { methodName: "m", args: { a: 1 }, gas: "30000000000000", deposit: "1" } },
      { type: "Transfer", params: { deposit: NEAR.toString() } },
      { type: "AddKey", params: { publicKey: KEY, accessKey: { permission: { receiverId: "c.testnet", methodNames: [], allowance: "5" } } } },
      { type: "DeployContract", params: { code: "AGFzbQEAAAA=" } },
    ]);
    expect(() => toWalletActions([{ kind: "use-global", ref: { account: "x.testnet" }, decoded: "" }])).toThrow(/browser wallet/);
  });
});

describe("docs, risk and output", () => {
  it("every command and helper is documented; autocomplete inserts are what scripts type", () => {
    const d = buildDocs();
    for (const m of Object.values(MODULES)) {
      for (const c of Object.keys(m.commands)) expect(m.docs[c], `${m.name}:${c}`).toBeTruthy();
      for (const h of Object.keys(m.helpers)) expect(m.docs[`@${h}`], `@${m.name}:${h}`).toBeTruthy();
    }
    const inserts = d.entries.map((e) => e.insert);
    expect(inserts).toEqual(expect.arrayContaining(["call", "transfer", "token:transfer", "exec", "@me", "@token:balance", "account:create", "chainsig:transfer", "load"]));
    expect(d.chains.mainnet.map((c) => c.name)).toEqual(expect.arrayContaining(["ethereum", "base", "bitcoin", "solana"]));
  });

  it("risk labels and the simulate header", async () => {
    const p = await plan('load chainsig\nassert @balance > 1near\ntransfer bob.testnet 20\nchainsig:transfer base "t" 0x000000000000000000000000000000000000dEaD 0.2', fakeEnv());
    const v = planView(p);
    expect(v.steps.map((s) => s.risk)).toEqual([
      ["read-only"],
      ["state-changing", "high-value"],
      ["state-changing"],
      ["state-changing", "irreversible", "high-value"],
    ]);
    expect(v.risk).toBe("high-value");
    expect(renderPlan(p, "x.cast")).toMatch(/^Mode: SIMULATE-ONLY \| Network: testnet \| Risk: \[HIGH-VALUE\]/);
  });
});
