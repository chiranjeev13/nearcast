import { describe, expect, it } from "vitest";
import { sign } from "viem/accounts";
import { inFlight, isComplete, memoryStore, newCheckpoint } from "../src/exec/checkpoint.js";
import { execute, type ExecOptions } from "../src/exec/executor.js";
import { canMove, nextAction, unseenNearTx } from "../src/exec/machine.js";
import { plan } from "../src/plan/planner.js";
import type { Checkpoint, Step, StepStatus } from "../src/plan/types.js";
import { renderReceipt } from "../src/render.js";
import { EXAMPLE, fakeEnv, type Fake } from "./fake.js";

const FAST: ExecOptions = { pollMs: 1, timeoutMs: 30, unknownGrace: 2, sleep: async () => {} };

class Killed extends Error {}
/** Die right after step `n` is persisted with `status`: the moral equivalent of kill -9. */
const killAt = (n: number, status: StepStatus): ExecOptions => ({
  ...FAST,
  afterPersist: (step: Step, s: StepStatus) => {
    if (step.index + 1 === n && s === status) throw new Killed();
  },
});

async function setup(src = EXAMPLE) {
  const env = fakeEnv();
  const p = await plan(src, env);
  const store = memoryStore();
  const cp = newCheckpoint(p);
  store.save(cp);
  return { env, store, cp };
}
/** What a new process sees: only what was persisted. */
const reload = (store: ReturnType<typeof memoryStore>): Checkpoint => store.load()!;
const count = (env: Fake, prefix: string) => env.calls.filter((c) => c.startsWith(prefix)).length;
const statuses = (cp: Checkpoint) => cp.plan.steps.map((s) => cp.state[s.id].status);

describe("state machine (pure)", () => {
  const near = { type: "near-tx" } as Step;
  const sign = { type: "near-tx", purpose: { kind: "mpc-sign" } } as Step;
  const evm = { type: "evm-tx" } as Step;
  const assert = { type: "assert" } as Step;

  it("maps every persisted status to exactly one resume action", () => {
    expect(nextAction(near, { status: "confirmed" })).toBe("skip");
    expect(nextAction(near, { status: "broadcast" })).toBe("poll");
    expect(nextAction(near, { status: "signed" })).toBe("rebroadcast");
    expect(nextAction(evm, { status: "signed" })).toBe("rebroadcast");
    expect(nextAction(near, { status: "planned" })).toBe("sign");
    expect(nextAction(assert, { status: "planned" })).toBe("evaluate");
  });

  it("retries failures only where that cannot double-execute", () => {
    expect(nextAction(assert, { status: "failed" })).toBe("retry");
    expect(nextAction(sign, { status: "failed" })).toBe("retry");
    expect(nextAction(near, { status: "failed" })).toBe("stop");
    expect(nextAction(near, { status: "failed" }, { retryFailed: true })).toBe("retry");
    expect(nextAction(evm, { status: "failed" }, { retryFailed: true })).toBe("stop");
  });

  it("re-signs an unseen NEAR transaction only when it provably cannot land", () => {
    expect(unseenNearTx("possible")).toBe("wait");
    expect(unseenNearTx("impossible")).toBe("resign");
    expect(unseenNearTx("ambiguous")).toBe("needs-human");
  });

  it("only allows forward moves, failure, and the proven-dead reset", () => {
    expect(canMove("planned", "signed")).toBe(true);
    expect(canMove("signed", "broadcast")).toBe(true);
    expect(canMove("broadcast", "confirmed")).toBe(true);
    expect(canMove("planned", "broadcast")).toBe(false);
    expect(canMove("signed", "confirmed")).toBe(false);
    expect(canMove("confirmed", "planned")).toBe(false);
    expect(canMove("confirmed", "failed")).toBe(false);
    expect(canMove("broadcast", "planned")).toBe(true);
    expect(canMove("failed", "planned")).toBe(true);
    expect(canMove("planned", "planned")).toBe(false);
  });
});

describe("executor", () => {
  it("runs the example to completion: one sign and one broadcast per transaction", async () => {
    const { env, store, cp } = await setup();
    expect(await execute(cp, env, store, FAST)).toEqual({ kind: "done" });
    expect(statuses(cp)).toEqual(["confirmed", "confirmed", "confirmed", "confirmed"]);
    expect(count(env, "near.sign")).toBe(2);
    expect(count(env, "near.broadcast")).toBe(2);
    expect(count(env, "evm.send")).toBe(1);
    expect(isComplete(reload(store))).toBe(true);
    // The EVM transaction that went out is the one the plan described.
    expect([...env.evmTxs.keys()]).toEqual([cp.state.s4.txHash]);
    const receipt = renderReceipt(cp);
    expect(receipt).toContain("All steps confirmed.");
    expect(receipt).toContain(cp.state.s2.txHash!);
  });

  it("batches signature requests into one NEAR transaction and gives each payment its own signature", async () => {
    const src = `load chainsig
batch (
  chainsig:on base "treasury" (
    exec @token(USDC) "transfer(address,uint256)" 0x000000000000000000000000000000000000dEaD 1e6
    exec @token(USDC) "transfer(address,uint256)" 0x000000000000000000000000000000000000bEEF 2e6
  )
)
`;
    const { env, store, cp } = await setup(src);
    expect(cp.plan.steps.map((s) => s.type)).toEqual(["near-tx", "evm-tx", "evm-tx"]);
    const signStep = cp.plan.steps[0] as any;
    expect(signStep.purpose.kind).toBe("mpc-sign-batch");
    expect(signStep.purpose.signs.map((r: any) => r.forStep)).toEqual(["s2", "s3"]);
    expect(cp.plan.steps.slice(1).map((s: any) => s.signedBy)).toEqual(["s1", "s1"]);
    expect(await execute(cp, env, store, FAST)).toEqual({ kind: "done" });
    expect(statuses(cp)).toEqual(["confirmed", "confirmed", "confirmed"]);
    expect(count(env, "near.sign")).toBe(1); // one wallet approval
    expect(count(env, "evm.send")).toBe(2);
    expect([...env.evmTxs.keys()].sort()).toEqual([cp.state.s2.txHash, cp.state.s3.txHash].sort());
  });

  it("a batch with chain signatures cannot mix in other NEAR actions", async () => {
    const env = fakeEnv();
    await expect(plan(`load chainsig
batch (
  transfer bob.testnet 1
  chainsig:on base "treasury" (
    exec @token(USDC) "transfer(address,uint256)" 0x000000000000000000000000000000000000dEaD 1e6
  )
)
`, env)).rejects.toThrow(/chain signatures go to/);
  });

  it("resume skips confirmed steps", async () => {
    const { env, store, cp } = await setup();
    await expect(execute(cp, env, store, killAt(2, "confirmed"))).rejects.toThrow(Killed);
    const cp2 = reload(store);
    expect(statuses(cp2)).toEqual(["confirmed", "confirmed", "planned", "planned"]);
    const before = env.calls.length;
    expect(await execute(cp2, env, store, FAST)).toEqual({ kind: "done" });
    const after = env.calls.slice(before);
    // The NEAR transfer (step 2) is never signed or sent again.
    expect(after.filter((c) => c.includes("near-3e2210"))).toEqual([]);
    expect(count(env, "near.sign")).toBe(2);
  });

  it("resume polls a broadcast step instead of sending a new transaction", async () => {
    const { env, store, cp } = await setup();
    await expect(execute(cp, env, store, killAt(2, "broadcast"))).rejects.toThrow(Killed);
    const cp2 = reload(store);
    expect(cp2.state.s2.status).toBe("broadcast");
    const hash = cp2.state.s2.txHash;
    expect(await execute(cp2, env, store, FAST)).toEqual({ kind: "done" });
    expect(cp2.state.s2.txHash).toBe(hash);
    expect(env.calls.filter((c) => c.startsWith(`near.sign ${hash} `))).toHaveLength(1);
    expect(env.calls.filter((c) => c === `near.broadcast ${hash}`)).toHaveLength(1);
  });

  it("resume rebroadcasts a signed step with the same signature and nonce", async () => {
    const { env, store, cp } = await setup();
    // Killed after signing, before the transaction ever reached the network.
    await expect(execute(cp, env, store, killAt(2, "signed"))).rejects.toThrow(Killed);
    const cp2 = reload(store);
    const { txHash, nonce, signedPayload } = cp2.state.s2;
    expect(cp2.state.s2.status).toBe("signed");
    expect(env.nearTxs.size).toBe(0);
    expect(await execute(cp2, env, store, FAST)).toEqual({ kind: "done" });
    expect(cp2.state.s2).toMatchObject({ txHash, nonce, signedPayload, status: "confirmed" });
    expect(env.calls.filter((c) => c.startsWith("near.sign near-3e2210"))).toHaveLength(1); // signed once, ever
    expect(env.calls.filter((c) => c === `near.broadcast ${txHash}`)).toHaveLength(1);
  });

  it("the EVM step is idempotent across a kill: same raw transaction, same pinned nonce", async () => {
    const { env, store, cp } = await setup();
    await expect(execute(cp, env, store, killAt(4, "signed"))).rejects.toThrow(Killed);
    const cp2 = reload(store);
    const { txHash, signedPayload } = cp2.state.s4;
    expect(env.evmTxs.size).toBe(0);
    await expect(execute(cp2, env, store, killAt(4, "broadcast"))).rejects.toThrow(Killed);
    const cp3 = reload(store);
    expect(await execute(cp3, env, store, FAST)).toEqual({ kind: "done" });
    expect(cp3.state.s4).toMatchObject({ txHash, signedPayload });
    expect([...env.evmTxs.keys()]).toEqual([txHash]);
    expect(count(env, "near.sign")).toBe(2); // the MPC signature was requested once
  });

  it("never re-signs while the earlier signed transaction could still land", async () => {
    const { env, store, cp } = await setup();
    env.onNearBroadcast = () => "drop"; // the network has not seen it (yet)
    env.landingVerdict = "possible";
    const out = await execute(cp, env, store, FAST);
    expect(out.kind).toBe("waiting");
    expect(cp.state.s2.status).toBe("broadcast");
    expect(count(env, "near.sign")).toBe(1);
    expect(inFlight(cp)).toEqual(["s2"]);
    // It shows up later: resume finishes with the original transaction.
    env.onNearBroadcast = undefined;
    const hash = cp.state.s2.txHash;
    expect(await execute(reload(store), env, store, FAST)).toEqual({ kind: "done" });
    expect(env.nearTxs.has(hash!)).toBe(true);
    expect(env.calls.filter((c) => c.startsWith("near.sign near-3e2210"))).toHaveLength(1);
  });

  it("signs a replacement only once the old transaction is provably dead", async () => {
    const { env, store, cp } = await setup();
    let dropped = 0;
    env.onNearBroadcast = (_h, receiver) => (receiver.startsWith("3e2210") && dropped++ < 1 ? "drop" : undefined as any);
    env.landingVerdict = "impossible"; // nonce unused and block hash expired
    expect(await execute(cp, env, store, FAST)).toEqual({ kind: "done" });
    const signs = env.calls.filter((c) => c.startsWith("near.sign near-3e2210"));
    expect(signs.length).toBe(2);
    expect(cp.state.s2.txHash).toBe(signs[1].split(" ")[1]);
  });

  it("stops for a human when it cannot tell whether the transaction landed", async () => {
    const { env, store, cp } = await setup();
    env.onNearBroadcast = () => "drop";
    env.landingVerdict = "ambiguous";
    const out = await execute(cp, env, store, FAST);
    expect(out).toMatchObject({ kind: "waiting" });
    expect((out as any).reason).toMatch(/Not re-signing, to avoid sending twice/);
    expect(count(env, "near.sign")).toBe(1);
  });

  it("a gate assert between steps halts the run; earlier steps stay done", async () => {
    const { env, store, cp } = await setup(`call a.testnet first {}
assert @view(c.testnet get_number) > 100 "counter too low"
call a.testnet second {}`);
    const out = await execute(cp, env, store, FAST);
    expect(out).toMatchObject({ kind: "failed", error: "counter too low: 7 > 100 is false" });
    expect(statuses(cp)).toEqual(["confirmed", "failed", "planned"]);
    expect(count(env, "near.sign")).toBe(1);
    const receipt = renderReceipt(cp);
    expect(receipt).toContain("1 of 3 steps confirmed. Stopped at step 2.");
    expect(receipt).toContain("Nothing was rolled back");
  });

  it("an EVM revert fails the step, keeps the receipt honest, and cannot be retried", async () => {
    const { env, store, cp } = await setup();
    env.onEvmSend = () => ({ state: "reverted", feePaid: 7n, blockNumber: 2n });
    const out = await execute(cp, env, store, FAST);
    expect(out).toMatchObject({ kind: "failed" });
    expect((out as any).error).toMatch(/reverted on Base Sepolia.*Earlier steps are NOT undone/);
    expect(statuses(cp)).toEqual(["confirmed", "confirmed", "confirmed", "failed"]);
    const again = await execute(reload(store), env, store, { ...FAST, retryFailed: true });
    expect(again.kind).toBe("failed");
    expect(count(env, "evm.send")).toBe(1);
  });

  it("a failed NEAR transaction stops the run and is retried only on request", async () => {
    const { env, store, cp } = await setup();
    let first = true;
    env.onNearBroadcast = (_h, receiver) =>
      receiver.startsWith("3e2210") && first ? ((first = false), { state: "failure", error: '{"ExecutionError":"Smart contract panicked: The account doesn\'t have enough balance"}' }) : (undefined as any);
    const out = await execute(cp, env, store, FAST);
    expect(out).toMatchObject({ kind: "failed", error: "Smart contract panicked: The account doesn't have enough balance" });
    expect((await execute(reload(store), env, store, FAST)).kind).toBe("failed");
    expect(count(env, "near.sign")).toBe(1);
    expect(await execute(reload(store), env, store, { ...FAST, retryFailed: true })).toEqual({ kind: "done" });
  });

  it("a timed-out MPC signature request is retried automatically, a bounded number of times", async () => {
    const { env, store, cp } = await setup();
    let fails = 0;
    env.onNearBroadcast = (_h, receiver) =>
      receiver.startsWith("v1.sig") && fails++ < 1 ? { state: "failure", error: '{"ExecutionError":"Smart contract panicked: Request has timed out."}' } : (undefined as any);
    expect(await execute(cp, env, store, FAST)).toEqual({ kind: "done" });
    expect(cp.state.s3.attempts).toBe(2);

    const b = await setup();
    b.env.onNearBroadcast = (_h, receiver) =>
      receiver.startsWith("v1.sig") ? { state: "failure", error: '{"ExecutionError":"Smart contract panicked: Request has timed out."}' } : (undefined as any);
    const out = await execute(b.cp, b.env, b.store, FAST);
    expect(out).toMatchObject({ kind: "failed" });
    expect((out as any).error).toMatch(/Request has timed out\. \(after 3 attempts\)/);
    expect(b.env.evmTxs.size).toBe(0);
  });

  it("refuses to broadcast if the MPC signature does not recover to the planned sender", async () => {
    for (const bad of [
      { big_r: { affine_point: "02" + "11".repeat(32) }, s: { scalar: "22".repeat(32) }, recovery_id: 0 }, // not a curve point
      await (async () => {
        const s = await sign({ hash: `0x${"ab".repeat(32)}`, privateKey: `0x${"01".repeat(32)}` }); // valid, wrong key
        return { big_r: { affine_point: `02${s.r.slice(2)}` }, s: { scalar: s.s.slice(2) }, recovery_id: s.yParity };
      })(),
    ]) {
      const { env, store, cp } = await setup();
      env.onNearBroadcast = (_h, receiver) => (receiver.startsWith("v1.sig") ? { state: "success", value: bad } : (undefined as any));
      const out = await execute(cp, env, store, FAST);
      expect(out).toMatchObject({ kind: "failed" });
      expect((out as any).error).toMatch(/refusing to broadcast/);
      expect(count(env, "evm.send")).toBe(0);
      expect(cp.state.s4.status).toBe("failed");
    }
  });

  it("the checkpoint survives a round trip with bigints intact", async () => {
    const { store, cp } = await setup();
    const back = reload(store);
    expect(back).toEqual(cp);
    expect(typeof (back.plan.steps[3] as any).maxFeePerGas).toBe("bigint");
  });
});
