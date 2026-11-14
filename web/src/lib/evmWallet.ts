import type { WalletRequest } from "@api";

/** The browser's injected EVM wallet (MetaMask, Rabby, Coinbase…), through EIP-1193. */
interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<any>;
  on?(event: string, cb: (...a: any[]) => void): void;
  removeListener?(event: string, cb: (...a: any[]) => void): void;
}

const provider = (): Eip1193 | null => ((window as any).ethereum as Eip1193 | undefined) ?? null;

export const hasEvmWallet = (): boolean => provider() !== null;

/** Ask the wallet for an account (shows its connect prompt the first time). */
export async function connectEvm(): Promise<string | null> {
  const p = provider();
  if (!p) throw new Error("no EVM wallet in this browser (install MetaMask)");
  const accounts: string[] = await p.request({ method: "eth_requestAccounts" });
  return accounts[0] ?? null;
}

/** The already-authorized account, without prompting. */
export async function currentEvm(): Promise<string | null> {
  const p = provider();
  if (!p) return null;
  try {
    const accounts: string[] = await p.request({ method: "eth_accounts" });
    return accounts[0] ?? null;
  } catch {
    return null;
  }
}

export function watchEvm(cb: (account: string | null) => void): () => void {
  const p = provider();
  if (!p?.on) return () => {};
  const h = (accounts: string[]) => cb(accounts[0] ?? null);
  p.on("accountsChanged", h);
  return () => p.removeListener?.("accountsChanged", h);
}

/** Switch to the request's chain (adding it if the wallet does not know it), then send. Returns the tx hash. */
export async function sendEvm(req: WalletRequest): Promise<string> {
  const p = provider();
  const e = req.evm;
  if (!p || !e) throw new Error("no EVM wallet");
  const [account] = await p.request({ method: "eth_requestAccounts" });
  if (!account || account.toLowerCase() !== e.from.toLowerCase()) {
    throw new Error(`switch your wallet to ${e.from} (it is on ${account ?? "no account"})`);
  }
  const chainId = `0x${e.chainId.toString(16)}`;
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch (err: any) {
    if (err?.code !== 4902) throw err;
    await p.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId,
        chainName: e.chainName,
        nativeCurrency: { name: e.symbol, symbol: e.symbol, decimals: 18 },
        rpcUrls: [e.rpcUrl],
        blockExplorerUrls: e.explorer ? [e.explorer] : [],
      }],
    });
  }
  const hash: string = await p.request({
    method: "eth_sendTransaction",
    params: [{ from: e.from, to: e.to, data: e.data, value: `0x${BigInt(e.value).toString(16)}` }],
  });
  return hash;
}
