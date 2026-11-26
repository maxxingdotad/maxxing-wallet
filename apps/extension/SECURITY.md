# MAXXING extension: security notes

Report a vulnerability to support@maxxing.ad. This file explains choices a reviewer may ask about.

## Content-Security-Policy: `connect-src https:`

The extension pages' policy (built by `src/lib/csp.ts` into `manifest.json` at build time):

```
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:;
connect-src 'self' https: http://localhost:* http://127.0.0.1:* http://[::1]:*;
object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

**Why `https:` and not a list of hosts.** People can add their own RPC endpoint, or a site can add a network
(`wallet_addEthereumChain`) after the user approves it. Those hosts are chosen after install, and a manifest's policy can't list
hosts that aren't known yet. Plain http is allowed only for this computer, for a local node. WebSocket is not allowed at all.

**What this does not open.** The policy covers *where* the pages may connect, not *what* they send. These limits still hold:

- Scripts, styles and images are the extension's own files only (`'self'`), so no outside code can run in the pages.
- Only reviewed files may call `fetch` (or reach other windows, the clipboard or the background). `tests/no-leak.test.ts` fails
  when any other file does. Each reviewed file says what it sends, and none sends keys, phrases or anything else that is
  secret:
  - `rpc.ts`: chain reads and signed transactions.
  - `balances.ts`: public addresses only.
  - `market.ts`: token addresses only.
  - `relay.ts`: quote inputs.
  - `swap-fee.ts`, `blocklist.ts` and `psl.ts`: nothing.
  - `user-networks.ts`: `eth_chainId` and the latest block.
- The same test runs every request the extension can make while a wallet is open: balances, prices, sends on EVM and Solana,
  Relay quotes and swaps. It checks that the URL, headers and body carry only addresses, amounts and signed transactions, never a
  recovery phrase, a private key or the PIN.

**What it trusts.** An RPC endpoint the user or a site added sees what any RPC sees: the addresses read and the transactions
sent. The wallet keeps these limits on it:

- Its chain id is checked when it's added, and again the first time it's used in each session. An endpoint that now answers for
  another chain is dropped and noted in Activity.
- Networks a site or the user added are tagged "Added by site" or "Added by you" wherever they appear. They can't take a listed
  network's name, they get no branded logo and no dollar value, and their priority fee is capped at 2 gwei.

**Without the allowance.** A narrower policy would mean either no custom endpoints and networks, or rebuilding the extension for
each new host. With it, a script that got into the pages could send data to any https host. Because scripts are limited to the
extension's own files, that would take a change to the shipped code itself.
