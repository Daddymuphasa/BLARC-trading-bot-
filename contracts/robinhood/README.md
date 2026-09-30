# Robinhood fee router

BLARC fee router for Robinhood Chain (chain id **4663**).

**This contract is not deployed. There is no contract address.** Do not invent one. `BLARC_ROBINHOOD_ROUTER` stays empty until someone with a deployer key deploys it. This repository has no deployer key and the bot never signs.

## What it does

One transaction, signed by the user. The bot holds no key.

- Inputs: token in, token out, amount in, `amountOutMinimum` (slippage), deadline, and the Uniswap v3 pool fee tier.
- Sends **1% (100 bps)** of the sell amount to the immutable fee recipient in the same transaction.
- Swaps the other **99%** through Uniswap **SwapRouter02** `exactInputSingle`.
- Bought tokens are paid to `msg.sender` (the user), not kept by the contract.
- If the fee transfer fails, the swap reverts, or the output is under the minimum, the whole transaction reverts. There is no fee-less path.
- Router allowance is set to the exact swap amount and reset to zero after the swap.
- Reentrancy is locked.
- No admin, no upgrade, no fee change, and no function that pulls user funds to an arbitrary address.

Native ETH in (`msg.value`, or token in `address(0)` / `0xeeee…`): 1% of the ETH goes to the fee wallet, the rest is wrapped as WETH, then swapped.

Native ETH out: the swap buys WETH into this contract, unwraps it, and sends ETH to the user. WETH is whatever `SwapRouter02.WETH9()` returns (verified `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`). Swapping native ETH for WETH, or WETH for native ETH, is refused: that is the same asset, not a pool.

## Constructor args

Both are set once and stored immutable.

| Arg | Value |
| --- | --- |
| `swapRouter_` | `0xCaf681a66D020601342297493863E78C959E5cb2` (SwapRouter02) |
| `feeRecipient_` | `0x729241d4d22cb8bD54E9210D1FE1e16b74A2a784` |

The constructor reverts if the fee recipient is any other address. It reads `WETH9()` from the router. Do not pass the general EVM fee wallet.

These Uniswap addresses were checked with `eth_getCode` on `https://rpc.mainnet.chain.robinhood.com` before they were written down. Code was present. `SwapRouter02.factory()` returned `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA`. `SwapRouter02.WETH9()` returned `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`. QuoterV2 `0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7` also had code. The bot quotes with QuoterV2. It does not call the Universal Router.

## Deploy

From this repo, with Foundry installed. The key stays in your shell. Do not put it in a file, do not commit it, and do not paste it into the bot `.env`.

```bash
export PATH="$PATH:$HOME/.foundry/bin"
cd /path/to/blarc

forge build

# ROBINHOOD_DEPLOYER_KEY must already be in the environment of the machine that deploys.
# This bot host does not have that key.
forge create contracts/robinhood/BlarcRobinhoodFeeRouter.sol:BlarcRobinhoodFeeRouter \
  --rpc-url https://rpc.mainnet.chain.robinhood.com \
  --chain 4663 \
  --private-key "$ROBINHOOD_DEPLOYER_KEY" \
  --broadcast \
  --constructor-args \
  0xCaf681a66D020601342297493863E78C959E5cb2 \
  0x729241d4d22cb8bD54E9210D1FE1e16b74A2a784
```

Compiler settings in `foundry.toml`: solc 0.8.26, optimizer on, 200 runs, Cancun.

If the RPC rejects a type-2 transaction, rerun the same `forge create` with `--legacy`. Still no key in the repo.

After the deploy transaction is confirmed, check the new address has code:

```bash
cast code "$BLARC_ROBINHOOD_ROUTER" --rpc-url https://rpc.mainnet.chain.robinhood.com
```

`cast code` must not print `0x`. Then set `BLARC_ROBINHOOD_ROUTER` in the bot `.env` to that deployed address and restart the **one** bot process (`node src/bot.js` / `npm start`). Do not start a second poller.

Until that variable is set to a contract with code, `/swap` on chain 4663 refuses with `Fee cannot be included, swap not sent.` It does not fall back to a direct 0x swap.

## Not deployed

No deploy was run from this workspace. There is no BLARC router address to put in `.env`. Leaving `BLARC_ROBINHOOD_ROUTER` empty is correct.
