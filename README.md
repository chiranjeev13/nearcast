# nearcast

Readable, resumable scripts for one NEAR account: native NEAR actions, tokens, NFTs, staking,
meta transactions, and EVM / Bitcoin / Solana through Chain Signatures.

```
load token
load chainsig

assert @chainsig:balance(base "treasury" USDC) >= 1e6 "treasury needs 1 USDC on Base"

token:transfer USDC alice.testnet 1
chainsig:on base "treasury" (
  exec @token(USDC) "transfer(address,uint256)" 0x000000000000000000000000000000000000dEaD 1e6
)
```

## Run

```
npm install && npm run build:web
nearcast ui                       # editor + autocomplete + docs, simulate, review, run; key or wallet
nearcast plan  script.cast        # SIMULATE: reads chain state, signs nothing
nearcast run   script.cast        # EXECUTE after confirmation (mainnet: type "send on mainnet")
nearcast resume script.cast       # continue from the checkpoint after any crash
nearcast docs [filter]            # every command and helper
```

`--network testnet|mainnet`, `--account <id>`. Keys: `NEAR_PRIVATE_KEY` or `~/.near-credentials/<network>/<account>.json`.
In the UI, a connected wallet (Meteor, HOT, MyNearWallet, Intear, MetaMask) can sign instead.

## Modules

| module | what |
|---|---|
| built in | `call`, `transfer`, `batch`, `seq`, `as <account> ( … )`, `@view`, `@balance`, `@exists` |
| `account` | create (sub-account or top-level), delete, add/delete key, deploy (+ init), global contracts |
| `token` | NEP-141 transfer, transfer-call, register, wrap/unwrap wNEAR; ERC-20 inside `chainsig:on` |
| `nft` | NEP-171 transfer, transfer-call, approve, revoke, owner/tokens/metadata |
| `stake` | staking pools (deposit, unstake, withdraw) and the native Stake action |
| `meta` | NEP-366: `meta:relay` (another account pays), `meta:sign` (hand to a relayer), `meta:submit` |
| `chainsig` | `chainsig:on <evm chain> ( exec … )`, `chainsig:transfer` on Ethereum, Base, Arbitrum, Optimism, Polygon, BNB, Bitcoin, Solana |
| `intents` | NEAR Intents (mainnet): `intents:swap 10 base:USDC arbitrum:USDC` bridges or swaps across NEAR, EVM chains, Bitcoin, Solana; your NEAR account signs the deposit |

## Guarantees

- Simulate first: plans read live state, estimate EVM gas, pin nonces and Bitcoin inputs, and check funding. Nothing is signed.
- Every step is labeled `[READ-ONLY]`, `[STATE-CHANGING]`, `[IRREVERSIBLE]` or `[HIGH-VALUE]`.
- Each transaction is atomic on its own; steps are not atomic with each other. `batch` and `meta` refuse a second receiver.
- Every status change is checkpointed before the next side effect. Resume never signs a second transaction for a step that might have landed; a wallet request whose answer was lost asks a human.
- MPC signatures are verified against the derived address before anything is broadcast.

## Limits

- NEAR Intents is mainnet only. Without `NEAR_INTENTS_API_KEY` / `NEAR_INTENTS_JWT`, 1Click adds its default app fee (0.01% when checked).
- Wallets cannot sign meta transactions or global-contract actions here; use a local key.
- MetaMask (NEAR's Ethereum-wallet support) splits multi-action transactions, so atomic steps are blocked for it.
- Bitcoin: P2WPKH, one payment per derived address per script. Solana: native SOL transfers (no SPL tokens yet).
