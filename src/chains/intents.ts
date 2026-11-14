import type { Env, IntentToken } from "../env.js";
import { INTENTS_API } from "../registry.js";

/**
 * NEAR Intents 1Click API. Optional auth: NEAR_INTENTS_JWT (Bearer) or NEAR_INTENTS_API_KEY.
 * Without either, 1Click adds its default app fee to each quote; the plan shows the quoted output.
 */
export function intentsEnv(): Env["intents"] {
  const base = (process.env.NEAR_INTENTS_API_URL ?? INTENTS_API).replace(/\/$/, "");
  const headers = (): Record<string, string> => {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (process.env.NEAR_INTENTS_JWT) h.authorization = `Bearer ${process.env.NEAR_INTENTS_JWT}`;
    if (process.env.NEAR_INTENTS_API_KEY) h["x-api-key"] = process.env.NEAR_INTENTS_API_KEY;
    return h;
  };
  const req = async (method: "GET" | "POST", path: string, body?: unknown): Promise<any> => {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await r.text();
    let data: any;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!r.ok) {
      const msg = typeof data === "object" && data ? data.message ?? data.error ?? text : text;
      throw new Error(`NEAR Intents ${path.split("?")[0]}: ${Array.isArray(msg) ? msg.join("; ") : msg} (HTTP ${r.status})`);
    }
    return data;
  };
  let tokens: Promise<IntentToken[]> | undefined;
  return {
    tokens: () => (tokens ??= req("GET", "/v0/tokens")),
    quote: (body) => req("POST", "/v0/quote", body),
    status: (depositAddress, memo) =>
      req("GET", `/v0/status?depositAddress=${encodeURIComponent(depositAddress)}${memo ? `&depositMemo=${encodeURIComponent(memo)}` : ""}`),
    async submit(txHash, depositAddress, memo) {
      try {
        await req("POST", "/v0/deposit/submit", { txHash, depositAddress, ...(memo ? { memo } : {}) });
      } catch {
        // Only a hint to speed things up; 1Click also watches the deposit address itself.
      }
    },
  };
}
