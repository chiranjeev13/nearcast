/** Minimal NEAR JSON-RPC client. Raw fetch so we control exactly what is sent and when. */

export class NearRpcError extends Error {
  constructor(
    message: string,
    readonly name_: string,
    readonly cause_: unknown,
  ) {
    super(message);
  }
}

export interface TxOutcome {
  /** "pending" = known to the network but not final yet; "unknown" = RPC has never seen it. */
  state: "success" | "failure" | "pending" | "unknown";
  /** Decoded SuccessValue (JSON if parseable, raw string otherwise). */
  value?: unknown;
  /** Decoded return value of every receipt that returned one. */
  values?: unknown[];
  error?: string;
  gasBurnt?: bigint;
  tokensBurnt?: bigint;
}

export const NEAR_RPC_DEFAULTS: Record<string, string[]> = {
  testnet: ["https://rpc.testnet.near.org", "https://test.rpc.fastnear.com"],
  mainnet: ["https://rpc.mainnet.near.org", "https://free.rpc.fastnear.com"],
};

export class NearRpc {
  constructor(readonly urls: string[]) {}

  async call<T = any>(method: string, params: unknown): Promise<T> {
    let lastErr: unknown;
    for (const url of this.urls) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        if (!res.ok) {
          lastErr = new Error(`NEAR RPC ${url} returned HTTP ${res.status}`);
          continue;
        }
        const body: any = await res.json();
        if (body.error) {
          const name = body.error.cause?.name ?? body.error.name ?? "RPC_ERROR";
          throw new NearRpcError(
            `${name}: ${body.error.data ? JSON.stringify(body.error.data) : body.error.message}`,
            name,
            body.error,
          );
        }
        return body.result as T;
      } catch (e) {
        if (e instanceof NearRpcError) throw e;
        lastErr = e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async view<T = any>(contract: string, method: string, args: unknown = {}): Promise<T> {
    const r = await this.call("query", {
      request_type: "call_function",
      finality: "final",
      account_id: contract,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    });
    if (r.error) throw new Error(`view ${contract}.${method} failed: ${r.error}`);
    const text = Buffer.from(r.result).toString();
    return (text === "" ? null : JSON.parse(text)) as T;
  }

  async account(id: string): Promise<{ amount: bigint; exists: boolean }> {
    try {
      const r = await this.call("query", { request_type: "view_account", finality: "final", account_id: id });
      return { amount: BigInt(r.amount), exists: true };
    } catch (e) {
      if (e instanceof NearRpcError && e.name_ === "UNKNOWN_ACCOUNT") return { amount: 0n, exists: false };
      throw e;
    }
  }

  async accessKey(id: string, publicKey: string): Promise<{ nonce: bigint; permission: unknown }> {
    const r = await this.call("query", {
      request_type: "view_access_key",
      finality: "final",
      account_id: id,
      public_key: publicKey,
    });
    return { nonce: BigInt(r.nonce), permission: r.permission };
  }

  async finalBlock(): Promise<{ hash: string; height: number }> {
    const r = await this.call("block", { finality: "final" });
    return { hash: r.header.hash, height: r.header.height };
  }

  /** True if `hash` is a block the chain still knows about (used for tx-expiry checks). */
  async blockHeight(hash: string): Promise<number | null> {
    try {
      const r = await this.call("block", { block_id: hash });
      return r.header.height;
    } catch (e) {
      if (e instanceof NearRpcError) return null;
      throw e;
    }
  }

  async gasPrice(): Promise<bigint> {
    const r = await this.call("gas_price", [null]);
    return BigInt(r.gas_price);
  }

  /** Submit without waiting. Resubmitting identical bytes is harmless: same hash, same nonce. */
  async broadcast(signedTxBase64: string): Promise<void> {
    try {
      await this.call("send_tx", { signed_tx_base64: signedTxBase64, wait_until: "NONE" });
    } catch (e) {
      // InvalidNonce here means "this exact nonce was already used" - i.e. our tx (or a
      // conflicting one) already landed. The status poll decides which.
      if (e instanceof NearRpcError && /InvalidNonce|already/i.test(e.message)) return;
      throw e;
    }
  }

  async txStatus(txHash: string, sender: string): Promise<TxOutcome> {
    let r: any;
    try {
      r = await this.call("tx", { tx_hash: txHash, sender_account_id: sender, wait_until: "NONE" });
    } catch (e) {
      if (e instanceof NearRpcError) {
        if (e.name_ === "UNKNOWN_TRANSACTION") return { state: "unknown" };
        if (e.name_ === "TIMEOUT_ERROR") return { state: "pending" };
      }
      throw e;
    }
    const fin = r.final_execution_status;
    const st = r.status;
    if (st && typeof st === "object" && "Failure" in st) {
      return { state: "failure", error: JSON.stringify(st.Failure), ...burnt(r) };
    }
    // Any failed receipt counts as failure even if the top-level status looks fine.
    const failed = (r.receipts_outcome ?? []).find((o: any) => o.outcome?.status?.Failure);
    if (failed) return { state: "failure", error: JSON.stringify(failed.outcome.status.Failure), ...burnt(r) };
    const done = fin === "FINAL" || fin === "EXECUTED" || fin === "EXECUTED_OPTIMISTIC";
    if (done && st && typeof st === "object" && "SuccessValue" in st) {
      const raw = Buffer.from(st.SuccessValue, "base64").toString();
      let value: unknown = raw;
      try {
        value = raw === "" ? null : JSON.parse(raw);
      } catch {}
      // Every receipt's return value: a transaction with several sign requests gets each signature
      // back in its own receipt, and only the last one is the transaction's value.
      const values: unknown[] = [];
      for (const o of r.receipts_outcome ?? []) {
        const v = o.outcome?.status?.SuccessValue;
        if (!v) continue;
        try {
          values.push(JSON.parse(Buffer.from(v, "base64").toString()));
        } catch {}
      }
      return { state: "success", value, values, ...burnt(r) };
    }
    return { state: "pending" };
  }
}

function burnt(r: any): { gasBurnt: bigint; tokensBurnt: bigint } {
  let gas = BigInt(r.transaction_outcome?.outcome?.gas_burnt ?? 0);
  let tok = BigInt(r.transaction_outcome?.outcome?.tokens_burnt ?? 0);
  for (const o of r.receipts_outcome ?? []) {
    gas += BigInt(o.outcome?.gas_burnt ?? 0);
    tok += BigInt(o.outcome?.tokens_burnt ?? 0);
  }
  return { gasBurnt: gas, tokensBurnt: tok };
}
