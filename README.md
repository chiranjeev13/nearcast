# nearcast

**Script every chain from one NEAR account.**

Nearcast is an editor for cross-chain work. You write a few readable lines, see exactly what will happen on every chain, then approve it in your NEAR wallet. It can pay someone in USDC on Base, send SOL on Solana, pay out in Bitcoin, or settle USDC from NEAR onto other chains, all in one script with one wallet.

**Try it:** https://nearcast-phi.vercel.app

```
load chainsig

assert @chainsig:balance(base "payroll" USDC) >= 1e6 "Base payroll wallet needs 1 USDC"

batch (
  chainsig:on base "payroll" (
    exec @token(USDC) "transfer(address,uint256)" 0xcC50098040cdD7F65f198f3EDF5baB02bC3dfa10 1e6
  )
  chainsig:transfer solana "payroll" 8xXETPXGab2fEyqhaeGeUkxxFXhGkC5wo8ndNzTikcZj 0.01
  chainsig:transfer bitcoin "payroll" tb1qsstasqk8t7qu0d9ywr7khf3nug2jyaszpkrl4d 0.00001
)
```

## Why

Moving money across chains today means a wallet per chain, a seed phrase per wallet, a bridge UI, and a lot of copy-pasted addresses. Nothing tells you what will happen before you sign, and if something fails halfway you're left working out which steps went through.

Nearcast replaces that with a short script and one NEAR account:

- **One account, every chain.** With NEAR Chain Signatures your NEAR account controls addresses on Base, Ethereum, Arbitrum, Optimism, Polygon, BNB Chain, Bitcoin and Solana. There are no extra wallets or seed phrases.
- **Bridge without a bridge.** NEAR Intents solvers deliver USDC and other tokens to other chains in seconds, quoted before you sign and refunded if a quote isn't filled.
- **See it before you sign it.** Simulate reads every chain and lists each step with exact amounts, fees and a risk tag. Nothing is signed until you review and approve.
- **Crash-safe.** Every step is checkpointed. Close the tab, lose the connection or hit a failure, and the run resumes where it stopped without paying twice.

## How it works

1. **Write.** Use a VS Code-style editor with autocomplete, hover docs and examples.
2. **Simulate.** Live balances, gas estimates, pinned nonces, Bitcoin inputs and Intents quotes. Every step is tagged `[READ-ONLY]`, `[STATE-CHANGING]`, `[IRREVERSIBLE]` or `[HIGH-VALUE]`.
3. **Review and execute.** Your NEAR wallet (Meteor, HOT, MyNearWallet, Intear, or MetaMask through NEAR's Ethereum wallet support) approves each transaction. `batch ( … )` groups several actions into one approval.
4. **Track and prove.** The Flow panel shows each chain as a lane and links every transaction to its explorer.

## What you can do

| | |
|---|---|
| **Pay across chains** | `chainsig:on base "treasury" ( exec … )`, `chainsig:transfer bitcoin …`, `chainsig:transfer solana …` |
| **Bridge and swap** | `intents:swap 10 from near:USDC to base:USDC --to 0x…` (mainnet), or `--from-wallet` to pay in from MetaMask |
| **Tokens and NFTs** | NEP-141 transfers with automatic registration, wNEAR wrap/unwrap, NEP-171 transfers and approvals |
| **Staking** | deposit, unstake, withdraw with any staking pool or liquid staking protocol |
| **Accounts** | create, delete, keys, deploy and init, global contracts |
| **Meta transactions** | NEP-366 relay, sign, submit |
| **Guards** | `assert @balance > 1near "…"` and `@token:balance`, `@chainsig:balance`, `@view` checks that stop the run before anything is signed |

Every command and helper is documented in the app's Docs pane, or run `nearcast docs`.

## Safety

- Simulate signs nothing. Execute only runs after you review the plan.
- Each transaction is atomic on its own; steps across chains are not, and the plan says so.
- Signatures from NEAR's MPC network are verified against the expected address before anything is broadcast.
- A run never sends a second transaction for a step that may already have landed. When it can't tell, it stops and asks.
- Mainnet steps are tagged `[HIGH-VALUE]`. The CLI asks you to type `send on mainnet`.

## Run locally

```
npm install
npm run build:web
nearcast ui                       # the editor in your browser
nearcast plan   script.cast       # simulate: reads chain state, signs nothing
nearcast run    script.cast       # execute after confirmation
nearcast resume script.cast       # continue from the checkpoint
nearcast docs [filter]            # every command and helper
```

`--network testnet|mainnet`, `--account <id>`. The CLI signs with `NEAR_PRIVATE_KEY` or `~/.near-credentials/<network>/<account>.json`; the web app signs with your wallet.

## Limits

- NEAR Intents runs on mainnet only.
- Bitcoin: one payment per address per script. Solana: native SOL only (no SPL tokens yet).
- Wallets can't sign meta transactions or global-contract actions; use a local key with the CLI.
- MetaMask (as a NEAR wallet) splits multi-action transactions, so it can't approve a `batch`.

## Built with

NEAR Chain Signatures, NEAR Intents (1Click), NEAR Wallet Selector, Monaco, React, Vite, Tailwind, chevrotain, viem, bitcoinjs-lib, @solana/web3.js.
