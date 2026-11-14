import { describe, expect, it } from "vitest";
import { memoryStore, newCheckpoint } from "../src/exec/checkpoint.js";
import { execute, type ExecOptions } from "../src/exec/executor.js";
import { plan } from "../src/plan/planner.js";
import type { AssertStep, EvmTxStep, IntentsWaitStep, NearTxStep } from "../src/plan/types.js";
import { renderPlan } from "../src/render.js";
import { planView } from "../src/ui/view.js";
import { DERIVED, fakeEnv, ME } from "./fake.js";

const FAST: ExecOptions = { pollMs: 1, timeoutMs: 30, unknownGrace: 2, sleep: async () => {} };
const mainnet = () => {
  const env = fakeEnv();
  (env.near as any).network = "mainnet";
  return env;
};
async function run(src: string, env = mainnet()) {
  const p = await plan(src, env);
  const store = memoryStore();
  const cp = newCheckpoint(p);
  store.save(cp);
  return { p, cp, env, out: await execute(cp, env, store, FAST) };
}

describe("NEAR Intents", () => {
  it("bridge from Base: quote → deadline gate → MPC-signed USDC deposit → wait for solvers", async () => {
    const { p, out, cp, env } = await run("load intents\nintents:swap 10 base:USDC arbitrum:USDC");
    expect(p.steps.map((s) => s.type)).toEqual(["assert", "near-tx", "evm-tx", "intents-wait"]);

    const q = env.intentQuotes[0];
    expect(q).toMatchObject({
      dry: false, swapType: "EXACT_INPUT", slippageTolerance: 50, amount: "10000000",
      originAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
      destinationAsset: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
      // Refund and recipient default to the address this NEAR account controls on each chain.
      refundTo: DERIVED, recipient: DERIVED, depositType: "ORIGIN_CHAIN", recipientType: "DESTINATION_CHAIN",
    });

    const gate = p.steps[0] as AssertStep;
    expect(gate.planResult.ok).toBe(true);
    const dep = p.steps[2] as EvmTxStep;
    expect(dep).toMatchObject({ to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", value: 0n, args: ["0x1111111111111111111111111111111111111111", 10_000_000n] });
    const wait = p.steps[3] as IntentsWaitStep;
    expect(wait).toMatchObject({ depositAddress: "0x1111111111111111111111111111111111111111", depositStep: "s3" });
    expect(wait.to.amountOut).toBe(9_990_000n);

    expect(out.kind).toBe("done");
    expect(env.intentSubmits).toHaveLength(1); // the deposit tx hash was handed to 1Click
    expect(cp.state.s4.result).toMatchObject({ status: "SUCCESS", destinationTxs: ["https://arbiscan.io/tx/0xdest"] });
    expect(planView(p, cp.state).steps[3]).toMatchObject({ kind: "wait", risk: ["read-only"], url: "https://arbiscan.io/tx/0xdest" });
  });

  it("from USDC on NEAR: an ft_transfer to the deposit account, registered first, signable by a wallet", async () => {
    const { p, out } = await run("load intents\nintents:swap 10 near:USDC arbitrum:USDC --to 0x2222222222222222222222222222222222222222");
    const dep = p.steps[1] as NearTxStep;
    expect(dep.receiver).toBe("17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1");
    expect((dep.actions as any[]).map((a) => a.method)).toEqual(["storage_deposit", "ft_transfer"]);
    expect((dep.actions as any[])[1].args).toEqual({ receiver_id: "aa".repeat(32), amount: "10000000" });
    expect((p.steps[2] as IntentsWaitStep).to.recipient).toBe("0x2222222222222222222222222222222222222222");
    expect((p.steps[2] as IntentsWaitStep).from.refundTo).toBe(ME);
    expect(out.kind).toBe("done");
  });

  it("`from` and `to` are optional words; both forms plan the same swap", async () => {
    const a = mainnet();
    const b = mainnet();
    await plan("load intents\nintents:swap 10 from base:USDC to arbitrum:USDC", a);
    await plan("load intents\nintents:swap 10 base:USDC arbitrum:USDC", b);
    const strip = (q: any) => ({ ...q, deadline: undefined });
    expect(strip(a.intentQuotes[0])).toEqual(strip(b.intentQuotes[0]));
    await expect(plan("load intents\nintents:swap 10 from base:USDC", mainnet())).rejects.toThrow(/usage: intents:swap <amount> from/);
  });

  it("--from-wallet: the user's own EVM wallet pays; refund and delivery go back to it; no NEAR, no MPC", async () => {
    const env = mainnet();
    const EOA = "0x3333333333333333333333333333333333333333" as const;
    (env as any).evmWallet = EOA;
    const p = await plan("load intents\nintents:swap 100 from base:USDC to arbitrum:USDC --from-wallet", env);
    expect(p.steps.map((s) => s.type)).toEqual(["assert", "evm-wallet-tx", "intents-wait"]);
    expect(env.intentQuotes[0]).toMatchObject({ refundTo: EOA, recipient: EOA, amount: "100000000" });
    const dep = p.steps[1] as any;
    expect(dep).toMatchObject({ from: EOA, to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", value: 0n });
    expect(dep.gas).toBe(65_000n); // simulated from the EOA (fake estimate 50k x 1.3)
    // The fake wallet holds 5 USDC: the plan is blocked, before anything is signed.
    expect(p.checks.some((c) => c.level === "fail" && /your wallet 0x3333.* holds 5 USDC/.test(c.description))).toBe(true);
    expect(planView(p).steps[1]).toMatchObject({ kind: "evm", signedWith: "wallet", risk: ["state-changing", "irreversible", "high-value"] });
    expect(env.calls.some((c) => c.startsWith("near.sign"))).toBe(false);
  });

  it("--from-wallet runs through the browser wallet, then waits for delivery", async () => {
    const env = mainnet();
    (env as any).evmWallet = "0x3333333333333333333333333333333333333333";
    const p = await plan("load intents\nintents:swap 1 from base:USDC to arbitrum:USDC --from-wallet", env);
    const store = memoryStore();
    const cp = newCheckpoint(p);
    store.save(cp);
    const asked: any[] = [];
    const hash = `0x${"ab".repeat(32)}`;
    env.evmTxs.set(hash, { state: "success", feePaid: 1000n, blockNumber: 1n });
    const out = await execute(cp, env, store, { ...FAST, evmWallet: async (s) => (asked.push(s), { txHash: hash }) });
    expect(out.kind).toBe("done");
    expect(asked).toHaveLength(1);
    expect(cp.state.s2).toMatchObject({ status: "confirmed", txHash: hash });
    expect(env.intentSubmits).toEqual([hash]);
  });

  it("--from-wallet: rejected in the wallet = nothing sent; a crash mid-prompt asks a human", async () => {
    const env = mainnet();
    (env as any).evmWallet = "0x3333333333333333333333333333333333333333";
    const p = await plan("load intents\nintents:swap 1 from base:USDC to arbitrum:USDC --from-wallet", env);
    let store = memoryStore();
    let cp = newCheckpoint(p);
    store.save(cp);
    expect(await execute(cp, env, store, { ...FAST, evmWallet: async () => ({ error: "User rejected" }) })).toMatchObject({ kind: "failed", error: "wallet: User rejected (nothing was sent)" });
    store = memoryStore();
    cp = newCheckpoint(p);
    store.save(cp);
    await expect(execute(cp, env, store, { ...FAST, evmWallet: () => Promise.reject(new Error("killed")) })).rejects.toThrow("killed");
    const again = store.load()!;
    expect(await execute(again, env, store, { ...FAST, evmWallet: async () => ({ txHash: "0x" }) })).toMatchObject({ kind: "waiting", handoff: true });
  });

  it("--from-wallet needs a connected EVM wallet and an EVM source chain", async () => {
    await expect(plan("load intents\nintents:swap 1 from base:USDC to arbitrum:USDC --from-wallet", mainnet())).rejects.toThrow(/needs an EVM wallet/);
    const env = mainnet();
    (env as any).evmWallet = "0x3333333333333333333333333333333333333333";
    await expect(plan("load intents\nintents:swap 1 from near:USDC to arbitrum:USDC --from-wallet", env)).rejects.toThrow(/near is not one/);
    await expect(plan("load intents\nintents:swap 1 from base:USDC to solana:SOL --from-wallet", env)).rejects.toThrow(/give the recipient on solana/);
  });

  it("native coins: ETH on Base is a plain value deposit", async () => {
    const { p } = await run("load intents\nintents:swap 0.01 base:ETH solana:SOL");
    expect(p.steps[2]).toMatchObject({ type: "evm-tx", to: "0x1111111111111111111111111111111111111111", value: 10n ** 16n, data: "0x" });
  });

  it("a refund stops the run with the reason and the next safe action", async () => {
    const env = mainnet();
    env.intentStatuses = ["REFUNDED"];
    const { out, cp, p } = await run("load intents\nintents:swap 10 base:USDC arbitrum:USDC", env);
    expect(out).toMatchObject({ kind: "failed", error: expect.stringMatching(/refunded to 0x.*price moved/) });
    expect(planView(p, cp.state).steps[3].hint).toMatch(/funds went back/);
  });

  it("still processing at the timeout: waiting, resumable, nothing re-sent", async () => {
    const env = mainnet();
    env.intentStatuses = ["PROCESSING"];
    const { out, cp } = await run("load intents\nintents:swap 10 base:USDC arbitrum:USDC", env);
    expect(out).toMatchObject({ kind: "waiting" });
    expect(cp.state.s3.status).toBe("confirmed"); // the deposit is done and is never sent twice
    const sends = env.calls.filter((c) => c.startsWith("evm.send")).length;
    env.intentStatuses = ["SUCCESS"];
    const store = memoryStore(cp);
    expect((await execute(store.load()!, env, store, FAST)).kind).toBe("done");
    expect(env.calls.filter((c) => c.startsWith("evm.send")).length).toBe(sends);
  });

  it("an expired quote blocks the deposit at run time", async () => {
    const env = mainnet();
    const p = await plan("load intents\nintents:swap 10 base:USDC arbitrum:USDC", env);
    const gate = p.steps[0] as AssertStep;
    (gate.left as any).args[0].value = new Date(Date.now() + 60_000).toISOString(); // only a minute left
    const store = memoryStore();
    const cp = newCheckpoint(p);
    store.save(cp);
    const out = await execute(cp, env, store, FAST);
    expect(out).toMatchObject({ kind: "failed", step: { id: "s1" } });
    expect(env.calls.some((c) => c.startsWith("near.sign"))).toBe(false);
  });

  it("refuses testnet, unknown tokens, deprecated assets, and recipients it cannot derive", async () => {
    await expect(plan("load intents\nintents:swap 10 base:USDC arbitrum:USDC", fakeEnv())).rejects.toThrow(/mainnet only/);
    await expect(plan("load intents\nintents:swap 10 base:DOGE arbitrum:USDC", mainnet())).rejects.toThrow(/no DOGE on base \(has: USDC, ETH\)/);
    await expect(plan("load intents\nintents:swap 1 bsc:BNB arbitrum:USDC", mainnet())).rejects.toThrow(/no BNB on bsc \(has: \)/);
    await expect(plan("load intents\nintents:swap 10 base:USDC tron:USDT", mainnet())).rejects.toThrow(/pass --to/);
    await expect(plan("load intents\nintents:swap 10 base:USDC arbitrum:USDC --slippage 20", mainnet())).rejects.toThrow(/above 10%/);
  });

  it("the plan reads as a dry run with exact amounts", async () => {
    const p = await plan("load intents\nintents:swap 10 base:USDC arbitrum:USDC --slippage 1", mainnet());
    const text = renderPlan(p, "bridge.cast");
    expect(text).toMatch(/^Mode: SIMULATE-ONLY \| Network: mainnet/);
    expect(text).toContain("receive   ~9.99 USDC on arbitrum, at least 9.94005 USDC (9940050 base units)");
    expect(text).toContain("✓ NEAR Intents: live quote 10 USDC → ~9.99 USDC, deposit address reserved");
  });
});
