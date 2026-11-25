# Gasless swap: mainnet test with about $1 (Base → Arbitrum)

A gasless swap pays with a token and takes the network fee out of the swap: you sign one EIP-3009 authorization for exactly the
amount, and Relay sends the transaction. This plan checks it once on mainnet with tiny amounts, using your own wallet. About 15
minutes. You spend about $1 of USDC plus Relay's fee (cents); you need no ETH on Base.

## What you need

- Chrome with this build loaded: `chrome://extensions` → Developer mode → Load unpacked → `apps/extension/dist/chrome`
  (after `corepack pnpm --filter @maxxing/extension build`).
- A **new** wallet in the extension, used only for this test (Create a new wallet, back it up).
- About **1.50 USDC on Base**, sent from another wallet to the new wallet's EVM address (Receive → EVM). Send no ETH: the test
  checks that none is needed.

## Steps

1. **Funds arrived.** Home shows the USDC on Base, and no ETH on Base.
2. **Open Swap.** You pay: USDC · Base, amount `1`. You get: ETH · Arbitrum (or USDC · Arbitrum).
3. **The gasless option.** Check that "Pay the network fee with USDC" shows, already ticked, and says you have no ETH on Base.
   - Changing "You get" to a token on Base (same network) hides the option. Expected: Relay's same-network gasless route needs a
     lasting allowance, which the wallet doesn't sign.
4. **Review swap.** Check each of these:
   - Network fee: "Paid from the swap · no ETH needed".
   - "1 authorization you'll sign", saying: "Lets Relay's contract 0xccc8…15be take exactly 1 USDC from you, once, for this swap.
     Unused, it expires <date, time>". The time is at most 24 hours ahead.
   - Minimum received and price impact look sensible for $1.
5. **Confirm swap.** The wallet signs the authorization (no transaction from you) and shows the progress, then "On its way" or
   "Arrived".
6. **On the explorers** (your address on basescan.org and arbiscan.io):
   - Base: one USDC transfer of exactly 1.00 USDC from your address to Relay's approval contract `0xccc88a9d…c315be`. The
     transaction was sent by Relay (its "From" isn't you). Your address's nonce is still 0 and your ETH balance on Base is still 0.
   - Arbitrum: the ETH (or USDC) arrived at the same address, a little under the quote's "You get", above "Minimum received".
7. **No allowance left.** On basescan, open USDC (`0x833589fC…02913`) → Contract → Read as Proxy:
   - `allowance(owner = your address, spender = 0xccc88a9d1b4ed6b0eaba998850414b24f1c315be)` is `0`.
   - `authorizationState(authorizer = your address, nonce = <the authorization's nonce>)` is `true` (used, can't be used again).
     The nonce is in Relay's transaction on Base: its input data (Decode Input Data) has the `receiveWithAuthorization` call.
8. **Activity.** The extension's Activity lists "Gasless swap sent through Relay (fee paid from the swap)".

## Also check (no funds needed)

- Pay with **DAI on Base** (or any token without EIP-3009): the gasless option doesn't show.
- Pay with **ETH**: no gasless option (there's nothing to authorize); the review shows "Network fee, at most … ETH".

## If something goes wrong

- **Relay doesn't take the authorization** (an error after Confirm): nothing moved. The signed authorization can only be used by
  Relay's approval contract and stops working at the expiry shown (24 hours at most). The USDC stays in your wallet.
- **It stays "On its way" for more than 10 minutes**: check the request on relay.link (search your address). Relay refunds to your
  address if it can't fill.
- Write down: the time, the amount, the swap's network pair, the Base and Arbitrum transaction hashes, and any message shown.

## Result to report

| Check | Result |
|---|---|
| Option shown and ticked with no ETH (step 3) | |
| Review: fee from the swap, exact amount, contract 0xccc8…15be, expiry ≤ 24 h (step 4) | |
| Base: exactly 1.00 USDC to 0xccc8…, sent by Relay, your nonce 0 (step 6) | |
| Arbitrum: received, above minimum (step 6) | |
| Allowance 0, authorization used (step 7) | |
| Same-network and DAI: no option | |
