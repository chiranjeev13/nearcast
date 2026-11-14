import type { Chain } from "./plan/types.js";

/** NEAR networks Nearcast can run on. */
export const NETWORKS = ["testnet", "mainnet"] as const;
export type NetworkName = (typeof NETWORKS)[number];

export type EvmDef = Chain & { kind: "evm"; rpcEnv: string; rpc: string; explorer: string; decimals: 18 };
export type BtcDef = Chain & { kind: "btc"; apiEnv: string; api: string; explorer: string; decimals: 8; symbol: "BTC" };
export type SolDef = Chain & { kind: "sol"; rpcEnv: string; rpc: string; explorer: (sig: string) => string; decimals: 9; symbol: "SOL" };
export type ForeignDef = EvmDef | BtcDef | SolDef;

const evm = (name: string, label: string, chainId: number, symbol: string, rpcEnv: string, rpc: string, explorer: string): EvmDef =>
  ({ kind: "evm", name, label, chainId, symbol, rpcEnv, rpc, explorer, decimals: 18 });

/** Chains a script can name in chainsig:* commands, per NEAR network. Every RPC can be overridden by its env var. */
export const CHAINS: Record<NetworkName, Record<string, ForeignDef>> = {
  testnet: {
    ethereum: evm("ethereum", "Ethereum Sepolia", 11155111, "ETH", "ETHEREUM_RPC_URL", "https://ethereum-sepolia-rpc.publicnode.com", "https://sepolia.etherscan.io/tx/"),
    base: evm("base", "Base Sepolia", 84532, "ETH", "BASE_RPC_URL", "https://sepolia.base.org", "https://sepolia.basescan.org/tx/"),
    arbitrum: evm("arbitrum", "Arbitrum Sepolia", 421614, "ETH", "ARBITRUM_RPC_URL", "https://sepolia-rollup.arbitrum.io/rpc", "https://sepolia.arbiscan.io/tx/"),
    optimism: evm("optimism", "OP Sepolia", 11155420, "ETH", "OPTIMISM_RPC_URL", "https://sepolia.optimism.io", "https://sepolia-optimism.etherscan.io/tx/"),
    polygon: evm("polygon", "Polygon Amoy", 80002, "POL", "POLYGON_RPC_URL", "https://polygon-amoy-bor-rpc.publicnode.com", "https://amoy.polygonscan.com/tx/"),
    bsc: evm("bsc", "BNB Testnet", 97, "BNB", "BSC_RPC_URL", "https://bsc-testnet-rpc.publicnode.com", "https://testnet.bscscan.com/tx/"),
    bitcoin: {
      kind: "btc", name: "bitcoin", label: "Bitcoin testnet", network: "testnet", symbol: "BTC", decimals: 8,
      apiEnv: "BITCOIN_API_URL", api: "https://blockstream.info/testnet/api", explorer: "https://blockstream.info/testnet/tx/",
    },
    solana: {
      kind: "sol", name: "solana", label: "Solana devnet", cluster: "devnet", symbol: "SOL", decimals: 9,
      rpcEnv: "SOLANA_RPC_URL", rpc: "https://api.devnet.solana.com", explorer: (s) => `https://explorer.solana.com/tx/${s}?cluster=devnet`,
    },
  },
  mainnet: {
    ethereum: evm("ethereum", "Ethereum", 1, "ETH", "ETHEREUM_RPC_URL", "https://ethereum-rpc.publicnode.com", "https://etherscan.io/tx/"),
    base: evm("base", "Base", 8453, "ETH", "BASE_RPC_URL", "https://mainnet.base.org", "https://basescan.org/tx/"),
    arbitrum: evm("arbitrum", "Arbitrum One", 42161, "ETH", "ARBITRUM_RPC_URL", "https://arb1.arbitrum.io/rpc", "https://arbiscan.io/tx/"),
    optimism: evm("optimism", "OP Mainnet", 10, "ETH", "OPTIMISM_RPC_URL", "https://mainnet.optimism.io", "https://optimistic.etherscan.io/tx/"),
    polygon: evm("polygon", "Polygon", 137, "POL", "POLYGON_RPC_URL", "https://polygon-bor-rpc.publicnode.com", "https://polygonscan.com/tx/"),
    bsc: evm("bsc", "BNB Smart Chain", 56, "BNB", "BSC_RPC_URL", "https://bsc-rpc.publicnode.com", "https://bscscan.com/tx/"),
    bitcoin: {
      kind: "btc", name: "bitcoin", label: "Bitcoin", network: "mainnet", symbol: "BTC", decimals: 8,
      apiEnv: "BITCOIN_API_URL", api: "https://blockstream.info/api", explorer: "https://blockstream.info/tx/",
    },
    solana: {
      kind: "sol", name: "solana", label: "Solana", cluster: "mainnet-beta", symbol: "SOL", decimals: 9,
      rpcEnv: "SOLANA_RPC_URL", rpc: "https://api.mainnet-beta.solana.com", explorer: (s) => `https://explorer.solana.com/tx/${s}`,
    },
  },
};

/** NEP-141 tokens by symbol. Checked against each contract's ft_metadata. */
export const NEAR_TOKENS: Record<NetworkName, Record<string, string>> = {
  testnet: {
    USDC: "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af",
    USDT: "usdt.fakes.testnet",
    wNEAR: "wrap.testnet",
  },
  mainnet: {
    USDC: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    USDT: "usdt.tether-token.near",
    wNEAR: "wrap.near",
  },
};

/** ERC-20 tokens by chain id. Checked against each contract's symbol() and decimals(). */
export const EVM_TOKENS: Record<number, Record<string, `0x${string}`>> = {
  11155111: { USDC: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" },
  84532: { USDC: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
  421614: { USDC: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" },
  11155420: { USDC: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7" },
  80002: { USDC: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582" },
  1: { USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7" },
  8453: { USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  42161: { USDC: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", USDT: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9" },
  10: { USDC: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" },
  137: { USDC: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F" },
  56: { USDC: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", USDT: "0x55d398326f99059fF775485246999027B3197955" },
};

export const MPC_SIGNER: Record<NetworkName, string> = {
  testnet: "v1.signer-prod.testnet",
  mainnet: "v1.signer",
};

/** Top-level account registrar: creates `name.testnet` / `name.near`. */
export const REGISTRAR: Record<NetworkName, string> = { testnet: "testnet", mainnet: "near" };

export const NEAR_EXPLORER: Record<NetworkName, string> = {
  testnet: "https://testnet.nearblocks.io/txns/",
  mainnet: "https://nearblocks.io/txns/",
};

/** Nearcast chain name -> NEAR Intents (1Click) blockchain id. */
export const INTENTS_CHAINS: Record<string, string> = {
  near: "near", ethereum: "eth", base: "base", arbitrum: "arb", optimism: "op",
  polygon: "pol", bsc: "bsc", bitcoin: "btc", solana: "sol",
};
export const INTENTS_API = "https://1click.chaindefuser.com";

export const TGAS = 10n ** 12n;
export const NEAR = 10n ** 24n;

export function isNetwork(n: string): n is NetworkName {
  return (NETWORKS as readonly string[]).includes(n);
}
