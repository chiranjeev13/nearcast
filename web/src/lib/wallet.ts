import { setupWalletSelector, type WalletSelector } from "@near-wallet-selector/core";
import { setupEthereumWallets } from "@near-wallet-selector/ethereum-wallets";
import { setupHereWallet } from "@near-wallet-selector/here-wallet";
import { setupIntearWallet } from "@near-wallet-selector/intear-wallet";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { setupModal, type WalletSelectorModal } from "@near-wallet-selector/modal-ui";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { PublicKey } from "@near-js/crypto";
import { actionCreators, type Action } from "@near-js/transactions";
import { createConfig, http, injected } from "@wagmi/core";
import { defineChain } from "viem";
import type { Network, WalletAction, WalletRequest } from "@api";

export interface WalletHandle {
  selector: WalletSelector;
  modal: WalletSelectorModal;
  network: Network;
}

export interface WalletAccount {
  accountId: string;
  walletId: string | null;
}

/** NEAR's EVM-compatible RPC (NEP-518), used when MetaMask controls a NEAR account. */
const NEAR_EVM = {
  mainnet: { id: 397, name: "NEAR Protocol", rpc: "https://eth-rpc.mainnet.near.org", explorer: "https://eth-explorer.near.org" },
  testnet: { id: 398, name: "NEAR Protocol Testnet", rpc: "https://eth-rpc.testnet.near.org", explorer: "https://eth-explorer-testnet.near.org" },
} as const;

function wagmiConfigFor(network: Network) {
  const n = NEAR_EVM[network];
  const chain = defineChain({
    id: n.id,
    name: n.name,
    nativeCurrency: { name: "NEAR", symbol: "NEAR", decimals: 18 },
    rpcUrls: { default: { http: [n.rpc] }, public: { http: [n.rpc] } },
    blockExplorers: { default: { name: "NEAR Explorer", url: n.explorer } },
    testnet: network === "testnet",
  });
  // Injected connector only: MetaMask and other browser-extension wallets, no WalletConnect project id needed.
  return createConfig({
    chains: [chain],
    transports: { [chain.id]: http(n.rpc) } as Record<number, ReturnType<typeof http>>,
    connectors: [injected({ shimDisconnect: true })],
  });
}

const cache = new Map<Network, Promise<WalletHandle>>();

/** One selector per network, created on first use. */
export function getWallet(network: Network): Promise<WalletHandle> {
  let p = cache.get(network);
  if (!p) {
    p = (async () => {
      const selector = await setupWalletSelector({
        network,
        modules: [
          setupMeteorWallet(),
          setupHereWallet(),
          setupIntearWallet(),
          setupMyNearWallet(),
          setupEthereumWallets({ wagmiConfig: wagmiConfigFor(network) as any, alwaysOnboardDuringSignIn: true }),
        ],
      });
      // No contractId: signing in adds no function-call key. Every transaction is approved in the wallet.
      const modal = setupModal(selector, { theme: "dark" });
      return { selector, modal, network };
    })();
    p.catch(() => cache.delete(network));
    cache.set(network, p);
  }
  return p;
}

export function activeAccount(h: WalletHandle): WalletAccount | null {
  const s = h.selector.store.getState();
  const a = s.accounts.find((x) => x.active) ?? s.accounts[0];
  return a ? { accountId: a.accountId, walletId: s.selectedWalletId } : null;
}

export function watchAccount(h: WalletHandle, cb: (a: WalletAccount | null) => void): () => void {
  const sub = h.selector.store.observable.subscribe(() => cb(activeAccount(h)));
  cb(activeAccount(h));
  return () => sub.unsubscribe();
}

export async function disconnect(h: WalletHandle): Promise<void> {
  const w = await h.selector.wallet();
  await w.signOut();
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The server's JSON actions -> @near-js/transactions Action objects (what wallet-selector 10 expects). */
export function toNearActions(actions: WalletAction[]): Action[] {
  return actions.map((a): Action => {
    switch (a.type) {
      case "FunctionCall":
        return actionCreators.functionCall(a.params.methodName, a.params.args, BigInt(a.params.gas), BigInt(a.params.deposit));
      case "Transfer":
        return actionCreators.transfer(BigInt(a.params.deposit));
      case "CreateAccount":
        return actionCreators.createAccount();
      case "DeleteAccount":
        return actionCreators.deleteAccount(a.params.beneficiaryId);
      case "AddKey": {
        const p = a.params.accessKey.permission;
        const key = p === "FullAccess"
          ? actionCreators.fullAccessKey()
          : actionCreators.functionCallAccessKey(p.receiverId, p.methodNames, p.allowance ? BigInt(p.allowance) : undefined);
        return actionCreators.addKey(PublicKey.from(a.params.publicKey), key);
      }
      case "DeleteKey":
        return actionCreators.deleteKey(PublicKey.from(a.params.publicKey));
      case "DeployContract":
        return actionCreators.deployContract(b64ToBytes(a.params.code));
      case "Stake":
        return actionCreators.stake(BigInt(a.params.stake), PublicKey.from(a.params.publicKey));
    }
  });
}

/** Ask the connected wallet to sign and send one transaction. Resolves to its hash. */
export async function sendWithWallet(h: WalletHandle, req: WalletRequest): Promise<string | null> {
  const w = await h.selector.wallet();
  const out: any = await w.signAndSendTransaction({
    signerId: req.signerId,
    receiverId: req.receiverId,
    actions: toNearActions(req.actions),
  });
  // Redirect wallets resolve with nothing; their hash arrives in the URL when the page comes back.
  if (!out) return null;
  return out.transaction?.hash ?? out.transaction_outcome?.id ?? null;
}

/** NEP-518 (MetaMask via ethereum-wallets) splits multi-action transactions into one transaction per action. */
export const splitsBatches = (walletId: string | null): boolean => walletId === "ethereum-wallets";
