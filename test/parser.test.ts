import { describe, expect, it } from "vitest";
import { parse } from "../src/lang/parser.js";

const EXAMPLE = `
load token
load chainsig

set $treasury @chainsig:address(base "treasury")
assert @chainsig:balance(base "treasury" ETH) > 0.0001e18   # gas money

token:transfer USDC alice.testnet 1
chainsig:on base "treasury" (
  exec @token(USDC) "transfer(address,uint256)" 0x000000000000000000000000000000000000dEaD 1e6
)
`;

describe("parser", () => {
  it("parses the target example", () => {
    const ast = parse(EXAMPLE);
    expect(ast.map((s) => s.kind)).toEqual(["load", "load", "set", "assert", "command", "command"]);
    const set = ast[2] as any;
    expect(set.name).toBe("treasury");
    expect(set.value).toMatchObject({ kind: "helper", module: "chainsig", name: "address" });
    expect(set.value.args.map((a: any) => a.value)).toEqual(["base", "treasury"]);
    const as = ast[3] as any;
    expect(as.op).toBe(">");
    expect(as.right).toMatchObject({ kind: "num", digits: 1n, exp: 14 });
    expect(as.text).toContain("assert @chainsig:balance");
    const tr = ast[4] as any;
    expect(tr).toMatchObject({ module: "token", name: "transfer" });
    expect(tr.args.map((a: any) => a.kind)).toEqual(["word", "word", "num"]);
    const on = ast[5] as any;
    expect(on).toMatchObject({ module: "chainsig", name: "on" });
    expect(on.block).toHaveLength(1);
    expect(on.block[0].name).toBe("exec");
    expect(on.block[0].args[0]).toMatchObject({ kind: "helper", name: "token", module: undefined });
    expect(on.block[0].args[3]).toMatchObject({ kind: "num", digits: 1n, exp: 6 });
  });

  it("keeps hex-looking account ids as words, not numbers", () => {
    const [s] = parse("call 3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af ft_metadata") as any[];
    expect(s.args[0]).toMatchObject({ kind: "word" });
    expect(s.args[1]).toMatchObject({ kind: "word", value: "ft_metadata" });
  });

  it("parses numbers exactly, with units", () => {
    const [s] = parse("print 1 0.5 1.5e18 0.1near 30tgas 1yocto") as any[];
    expect(s.args.map((a: any) => [a.digits, a.exp, a.unit])).toEqual([
      [1n, 0, undefined], [5n, -1, undefined], [15n, 17, undefined],
      [1n, -1, "near"], [30n, 0, "tgas"], [1n, 0, "yocto"],
    ]);
  });

  it("parses call with JSON args and options", () => {
    const [s] = parse('call c.testnet m {"a": $x, "b": [1, "s", true], "c": {"d": @me}} --deposit 1yocto --gas 30tgas') as any[];
    expect(s.args[2].kind).toBe("object");
    expect(s.args[2].entries.map((e: any) => e.key)).toEqual(["a", "b", "c"]);
    expect(s.args[2].entries[1].value.items).toHaveLength(3);
    expect(Object.keys(s.opts)).toEqual(["deposit", "gas"]);
  });

  it("parses batch and seq blocks, nested, with comments and blank lines", () => {
    const ast = parse(`seq (
  # comment
  batch usdc.testnet (
    call usdc.testnet a {}

    call usdc.testnet b {}
  )
  call other.testnet c
)`) as any[];
    expect(ast[0].name).toBe("seq");
    expect(ast[0].block[0].name).toBe("batch");
    expect(ast[0].block[0].block.map((c: any) => c.args[1].value)).toEqual(["a", "b"]);
    expect(ast[0].block[1].loc.line).toBe(8);
  });

  it("distinguishes @helper(args) from @helper followed by a block", () => {
    const [s] = parse("foo:bar @me (\n  print 1\n)") as any[];
    expect(s.args[0]).toMatchObject({ kind: "helper", name: "me", args: [] });
    expect(s.block).toHaveLength(1);
  });

  it("reports errors with line numbers", () => {
    expect(() => parse("load token\nset treasury 1")).toThrow(/line 2: usage: set/);
    expect(() => parse("seq (\n  print 1\n")).toThrow(/syntax error/);
    expect(() => parse("print 1 > 2")).toThrow(/line 1: "print" does not take ">"/);
    expect(() => parse("call a.testnet m ^")).toThrow(/line 1: unexpected character/);
    expect(() => parse("assert 1 2")).toThrow(/usage: assert/);
    expect(() => parse("call a b --gas 1 --gas 2")).toThrow(/given twice/);
  });
});
