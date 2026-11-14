import { describe, expect, it } from "vitest";
import { plan } from "../src/plan/planner.js";
import type { EvmTxStep, NearTxStep } from "../src/plan/types.js";
import { planProblems, renderPlan } from "../src/render.js";
import { signingHash } from "../src/evm/tx.js";
import { DERIVED, EXAMPLE, fakeEnv, ME, USDC_BASE, USDC_NEAR } from "./fake.js";

const TGAS = 10n ** 12n;

describe("planner: script in, step list out", () => {
  it("turns the example into the expected flat list", async () => {
    const env = fakeEnv();
    const p = await plan(EXAMPLE, env);
    expect(p.steps.map((s) => [s.index, s.id, s.type])).toEqual([
      [0, "s1", "assert"], [1, "s2", "near-tx"], [2, "s3", "near-tx"], [3, "s4", "evm-tx"],
    ]);

    expect(p.steps[0]).toMatchObject({ phase: "preflight", planResult: { ok: true, detail: "10000000000000000 > 100000000000000" } });

    // alice is not registered: storage_deposit is prepended in the SAME transaction.
    const transfer = p.steps[1] as NearTxStep;
    expect(transfer).toMatchObject({ sender: ME, receiver: USDC_NEAR, atomic: true, source: { line: 7 } });
    expect((transfer.actions as any[]).map((a) => [a.method, a.deposit, a.gas])).toEqual([
      ["storage_deposit", 1250000000000000000000n, 30n * TGAS],
      ["ft_transfer", 1n, 30n * TGAS],
    ]);
    expect((transfer.actions as any[])[0].args).toEqual({ account_id: "alice.testnet", registration_only: true });
    expect((transfer.actions as any[])[1].args).toEqual({ receiver_id: "alice.testnet", amount: "1000000" });
    // attached 60 Tgas + 5 Tgas transaction base + 3 Tgas per function call (send/exec fees)
    expect(transfer.maxFee).toBe(71n * TGAS * 100_000_000n);

    const evm = p.steps[3] as EvmTxStep;
    expect(evm).toMatchObject({
      sender: DERIVED, to: USDC_BASE, nonce: 3, value: 0n, signedBy: "s3",
      chain: { chainId: 84532 }, derivation: { accountId: ME, path: "treasury" },
      args: ["0x000000000000000000000000000000000000dEaD", 1000000n],
    });
    expect(evm.data).toBe("0xa9059cbb000000000000000000000000000000000000000000000000000000000000dead00000000000000000000000000000000000000000000000000000000000f4240");
    expect(evm.gas).toBe(65_000n);
    expect(evm.description).toContain("send 1 USDC to 0x000000000000000000000000000000000000dEaD");

    // The sign request commits to exactly the planned EVM transaction, and shows its deposit.
    const sign = p.steps[2] as NearTxStep;
    expect(sign).toMatchObject({ receiver: "v1.signer-prod.testnet", purpose: { kind: "mpc-sign", forStep: "s4", path: "treasury" } });
    expect((sign.actions as any[])).toHaveLength(1);
    expect((sign.actions as any[])[0]).toMatchObject({ method: "sign", deposit: 1n, gas: 50n * TGAS });
    expect((sign.actions as any[])[0].args).toEqual({
      request: { payload_v2: { Ecdsa: signingHash(evm).slice(2) }, path: "treasury", domain_id: 0 },
    });

    expect(planProblems(p)).toEqual([]);
    expect(env.calls.some((c) => /sign|broadcast|send/.test(c))).toBe(false); // planning never signs or sends
    const text = renderPlan(p, "x.cast");
    expect(text).toContain("ATOMIC");
    expect(text).toContain("NOT atomic with each other");
  });

  it("skips storage_deposit when the recipient is already registered", async () => {
    const env = fakeEnv();
    env.registered.add("alice.testnet");
    const p = await plan("load token\ntoken:transfer USDC alice.testnet 0.5", env);
    const s = p.steps[0] as NearTxStep;
    expect((s.actions as any[]).map((a) => a.method)).toEqual(["ft_transfer"]);
    expect((s.actions as any[])[0].args).toMatchObject({ amount: "500000" });
    expect(s.atomic).toBe(false);
  });

  it("batch on one receiver is a single atomic transaction", async () => {
    const p = await plan(`load token
batch USDC_CONTRACT (
  token:transfer USDC_CONTRACT alice.testnet 1
  call USDC_CONTRACT ft_transfer {"receiver_id": "bob.testnet", "amount": "5"} --deposit 1yocto
)`.replaceAll("USDC_CONTRACT", USDC_NEAR), fakeEnv());
    expect(p.steps).toHaveLength(1);
    const s = p.steps[0] as NearTxStep;
    expect(s.atomic).toBe(true);
    expect((s.actions as any[]).map((a) => a.method)).toEqual(["storage_deposit", "ft_transfer", "ft_transfer"]);
  });

  it("batch with a second receiver is a compile error, not a silent downgrade", async () => {
    const src = `batch a.testnet (
  call a.testnet one {}
  call b.testnet two {}
)`;
    await expect(plan(src, fakeEnv())).rejects.toThrow(/line 3: batch a\.testnet cannot contain an action on b\.testnet.*atomic only when every action goes to one receiver/s);
  });

  it("seq is ordered and not atomic: one step per call, even to the same receiver", async () => {
    const p = await plan(`seq (
  call a.testnet one {}
  call a.testnet two {} --gas 100tgas --deposit 0.5near
)`, fakeEnv());
    expect(p.steps.map((s) => (s as NearTxStep).actions.length)).toEqual([1, 1]);
    expect((p.steps[1] as NearTxStep).actions[0]).toMatchObject({ gas: 100n * TGAS, deposit: 5n * 10n ** 23n });
    expect((p.steps[1] as NearTxStep).atomic).toBe(false);
  });

  it("rejects mixing that would hide non-atomicity", async () => {
    const e = fakeEnv();
    await expect(plan('load chainsig\nbatch a.testnet (\n  chainsig:on base "t" (\n  )\n)', e)).rejects.toThrow(/can never be atomic with a NEAR transaction/);
    await expect(plan("batch a.testnet (\n  seq (\n  )\n)", e)).rejects.toThrow(/seq cannot be used inside a batch/);
    await expect(plan('load chainsig\nchainsig:on base "t" (\n  call a.testnet m {}\n)', e)).rejects.toThrow(/line 3: NEAR commands are not allowed inside chainsig:on/);
    await expect(plan('exec 0x036CbD53842c5426634e7929541eC2318f3dCF7e "f()"', e)).rejects.toThrow(/unknown command "exec"/);
    await expect(plan("batch a.testnet (\n)", e)).rejects.toThrow(/batch is empty/);
    await expect(plan("batch a.testnet (\n  call a.testnet m {}\n  assert 1 > 0\n)", e)).rejects.toThrow(/assert cannot gate inside a batch/);
  });

  it("assert before any transaction is preflight; after one it is a gate", async () => {
    const p = await plan(`assert @view(c.testnet get_number) == 7
call a.testnet m {}
assert @view(c.testnet get_number) > 100 "counter too low"`, fakeEnv());
    expect(p.steps.map((s) => (s.type === "assert" ? s.phase : s.type))).toEqual(["preflight", "near-tx", "gate"]);
    // A gate that is false at plan time does not block the plan: it is decided when the run gets there.
    expect(planProblems(p)).toEqual([]);
  });

  it("a failing preflight assert or an unfunded derived address blocks the plan", async () => {
    const env = fakeEnv();
    env.ethBalance = 0n;
    const p = await plan(EXAMPLE, env);
    const problems = planProblems(p);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/line 5: .*0 > 100000000000000 is false/);
    expect(problems[1]).toMatch(new RegExp(`${DERIVED} on Base Sepolia has 0 ETH but gas and value need up to`));
    expect(renderPlan(p, "x")).toContain("BLOCKED");
  });

  it("pins consecutive EVM nonces and warns when a call would currently revert", async () => {
    const env = fakeEnv();
    env.estimateRevert = "ERC20: transfer amount exceeds balance";
    const p = await plan(`load chainsig
chainsig:on base "treasury" (
  exec ${USDC_BASE} "approve(address,uint256)" 0x000000000000000000000000000000000000dEaD 5
  exec ${USDC_BASE} "transfer(address,uint256)" 0x000000000000000000000000000000000000dEaD 5 --value 1
)`, env);
    const evm = p.steps.filter((s) => s.type === "evm-tx") as EvmTxStep[];
    expect(evm.map((s) => s.nonce)).toEqual([3, 4]);
    expect(evm[1].value).toBe(1n);
    expect(evm[0].gas).toBe(200_000n);
    expect(p.checks.filter((c) => c.level === "warn")).toHaveLength(2);
    expect(p.steps.map((s) => s.type)).toEqual(["near-tx", "evm-tx", "near-tx", "evm-tx"]);
  });

  it("flags a NEAR token balance that cannot cover the transfer", async () => {
    const env = fakeEnv();
    env.usdcNear = 10n;
    const p = await plan("load token\ntoken:transfer USDC alice.testnet 1", env);
    expect(planProblems(p)[0]).toMatch(/holds 0.00001 USDC, less than the 1 USDC/);
  });

  it("reports helpful errors with line numbers", async () => {
    const e = fakeEnv();
    await expect(plan("token:transfer USDC a.testnet 1", e)).rejects.toThrow(/line 1: module "token" is not loaded/);
    await expect(plan("load token\ntransfer USDC a.testnet 1", e)).rejects.toThrow(/for tokens use token:transfer/);
    await expect(plan("load nope", e)).rejects.toThrow(/unknown module "nope"/);
    await expect(plan("print $x", e)).rejects.toThrow(/line 1: \$x is not set/);
    await expect(plan("load token\ntoken:transfer USDC a.testnet 0.0000001", e)).rejects.toThrow(/more than 6 decimal places/);
    await expect(plan('load chainsig\nchainsig:on base "t" (\n  exec 0x036CbD53842c5426634e7929541eC2318f3dCF7e "transfer(address,uint256)" alice 1\n)', e)).rejects.toThrow(/line 3: argument 1 of transfer: expected an EVM address/);
    await expect(plan('load chainsig\nset $a @chainsig:address(polkadot "x")', e)).rejects.toThrow(/unknown chain "polkadot"/);
    await expect(plan("call a.testnet m {} --gas 2000tgas", e)).rejects.toThrow(/over the 1000 Tgas per-transaction limit/);
  });

  it("set, print and helpers with decimals", async () => {
    const p = await plan(`load token
set $amt @token:amount(USDC 2.5)
print "amount" $amt @token:balance(USDC) @me`, fakeEnv());
    expect(p.prints).toEqual([`amount 2500000 20000000 ${ME}`]);
    expect(p.steps).toEqual([]);
  });
});
