# MAXXING Wallet: store listing

Copy for the Chrome Web Store, Microsoft Edge Add-ons and Firefox Add-ons (AMO). Packages come from `node scripts/package.mjs`
(see the end of this file); store screenshots from `node scripts/store-shots.mjs`.

## Name and summary

- **Name:** MAXXING Wallet
- **Short description (132 characters max, Chrome):**
  Your keys on your device, every chain in one balance, and every request shown in plain words before you sign.
- **Category:** Productivity (Chrome) · Tools (Edge) · Privacy & Security (Firefox)
- **Language:** English

## Description

MAXXING Wallet is a self-custody wallet for EVM chains and Solana. Your recovery phrase and keys are created and kept on your
device, encrypted with your password. MAXXING never has them.

- One recovery phrase, many accounts, on Ethereum, Base, Arbitrum, BNB Chain, Solana and every other network in MAXXING's list.
- One balance across every network.
- Send, and swap or bridge between networks through Relay. Bridging a token that supports it, such as USDC? Turn on "Pay the
  network fee with" it: you sign a one-time authorization for exactly that amount, and the fee comes out of the swap, no ETH needed.
- Every request a site makes is shown in plain words before you sign: what it spends, what it allows, and on which network.
  Unlimited token approvals and look-alike messages are called out.
- Sites connect only when you say so, and only to the account you chose. A site connected with one account can't sign with another.
- Known scam sites are blocked using a public phishing blocklist. Sites whose names read as MAXXING but aren't maxxing.ad get a warning.
- One password opens every wallet and account on the device. The wallet locks itself after the time you pick, and when the
  browser starts. Only your password opens it again, and wrong tries wait longer each time.
- Showing your recovery phrase or private keys takes several steps, with warnings, your password, and a final tap to reveal. A copied
  secret is cleared from the clipboard after 60 seconds if it's still there.
- Works as a toolbar popup, in Chrome's side panel, or in a full tab.

The wallet's code is public: github.com/maxxingdotad/maxxing-wallet (the browser extension and wallet core are source-available
under BUSL-1.1; the SDK sites use is MIT). The public CI builds every commit with the lockfile's exact dependencies and prints
the hash of each file and package, so anyone can rebuild a commit with the same Node and pnpm and compare.

Support: support@maxxing.ad

## Single purpose (Chrome)

A cryptocurrency wallet: it holds the user's keys on their device, shows balances, sends and swaps, and lets websites the user
connects ask for signatures, which the user approves or declines one by one.

## Permission justifications (Chrome)

| Permission | Why |
|---|---|
| `storage` | Keeps the encrypted wallet, settings and connected sites on the device, and the open session in memory-only session storage. |
| `alarms` | Runs the auto-lock, refreshes the phishing blocklist and the public suffix list, and clears a copied secret from the clipboard after 60 seconds. |
| `sidePanel` | Lets the user open the wallet in Chrome's side panel. |
| `clipboardWrite` | Copies addresses, and a secret when the user asks. |
| `offscreen` | A service worker has no clipboard; an offscreen document clears a copied secret after 60 seconds, after the popup has closed. |
| `clipboardRead` (optional, asked the first time a secret is copied) | To clear the clipboard only if it still holds the secret, leaving anything copied since. |
| Host permissions | None. Swap and bridge quotes come from Relay's public API, which answers any origin; every address the pages may reach is listed in their Content-Security-Policy. |
| Content scripts on `https://*/*` | Lets websites find the wallet (EIP-6963, Wallet Standard) and send it requests; the script carries messages only and reads nothing from the page. |
| Content scripts on `http://localhost/*` and `http://127.0.0.1/*` | Lets developers connect the wallet to a site they run on their own computer while building it (the same messages-only script; no other plain-http site gets it). |
| Remote code | None. All code ships in the package; the pages' Content-Security-Policy allows only the extension's own scripts. |

## Data use disclosures (Chrome "Privacy practices")

- **Collected and sent off the device:** wallet addresses (public). Sent to the MAXXING API (balances, prices), Relay (swap and
  bridge quotes), and the networks' public RPC endpoints (balances, sending signed transactions).
- **Never collected or sent:** the recovery phrase, private keys, the password, browsing history, page content, personal
  communications, location, health or financial information other than public addresses and the swaps the user asks for.
- **Downloads that send nothing about the user:** a public phishing blocklist and the Public Suffix List, twice a day.
- Not sold, not used for advertising or credit, not transferred except as needed for the features above.

## Privacy policy

https://maxxing.ad/docs/privacy (the section "The MAXXING Wallet browser extension", effective 25 November 2026).

## Firefox (AMO) notes

- Add-on id `wallet@maxxing.ad`; Firefox 128 or later.
- AMO asks for the source of minified code: upload `maxxing-wallet-source-<version>.zip`, which `scripts/package.mjs` makes in a
  clean checkout of the public repository (`git archive` of the commit: the extension, the wallet core, the SDK and the lockfile).
  Build steps for the reviewer: Node 22, `corepack pnpm install --frozen-lockfile`, `corepack pnpm --filter @maxxing/extension build`;
  the output is `apps/extension/dist/firefox`.
- Firefox has no offscreen documents, so the Firefox build offers no Copy button for secrets (they can't be cleared afterwards).

## Edge

The Chrome package works unchanged (same zip). Edge's side panel follows Chrome's API.

## Before submitting

1. `node scripts/update-phishing-list.mjs` and commit the refreshed lists.
2. Bump `version` in `public/manifest.json` and `package.json`.
3. `corepack pnpm --filter @maxxing/extension build`, the tests and `node scripts/e2e.mjs`.
4. `node scripts/package.mjs` → `store/out/`.
5. `STORE_DEMO=1 node scripts/e2e.mjs <folder>` (the real extension with sample balances, not anyone's wallet), then
   `node scripts/store-shots.mjs <folder>` → `store/out/screenshots/` (1280×800).
6. Check https://maxxing.ad/docs/privacy still describes what the extension sends, then submit.
