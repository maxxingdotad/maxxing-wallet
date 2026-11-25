# @maxxing/wallet-sdk

Let people use their MAXXING wallet on your site: sign in, sign messages and send transactions on EVM networks and Solana.

- **Users keep their keys.** The wallet lives on `wallet.maxxing.ad`. Your site gets addresses and signatures, never a key.
- **Every signature is confirmed.** Each request opens the MAXXING wallet window with your app's name, logo and website, and shows
  exactly what will be signed.
- **Works with what you use.** A standard EIP-1193 provider announced with EIP-6963 (wagmi, RainbowKit, viem, ethers), and a
  Solana Wallet Standard wallet (`@solana/wallet-adapter`).

## Quick start

```bash
npm install @maxxing/wallet-sdk
```

```js
import { createMaxxingWallet } from "@maxxing/wallet-sdk";

const wallet = createMaxxingWallet({ appId: "app_your_app_id", chains: [8453] });

button.onclick = async () => {
  const { evm, solana } = await wallet.connect(); // opens the wallet window
};
```

Get your app id at [developers.maxxing.ad](https://developers.maxxing.ad). Full docs, live examples and an API reference with "Try
it" are at [developers.maxxing.ad/docs](https://developers.maxxing.ad/docs).

## Contents

- [Requirements](#requirements)
- [1. Register your app](#1-register-your-app)
- [2. Install](#2-install)
- [3. Connect](#3-connect): JavaScript, React, wagmi, viem, Solana
- [Options](#options)
- [Sign in with Google, X, TikTok and more](#sign-in-with-google-x-tiktok-and-more)
- [Connect button](#connect-button) and [wallet window](#wallet-window) in your brand
- [React](#react)
- [Data API](#data-api), [live updates](#live-updates) and the [trade widget](#trade-widget)
- [Content-Security-Policy](#content-security-policy)
- [EIP-1193 requests](#eip-1193-requests) and [errors](#errors)
- [Server API](#server-api), [webhooks](#webhooks) and [verifying a sign-in on your server](#verifying-a-wallet-sign-in-on-your-server)
- [Security](#security), [versioning](#versioning), [support](#support) and [license](#license)

## Requirements

- **Browsers:** current Chrome, Edge, Firefox and Safari, on desktop and mobile. The wallet opens in its own window, so call
  `connect()` and every signing request from a click; browsers block windows opened without one.
- **Server helpers** (`@maxxing/wallet-sdk/server`): Node 18 or newer, Bun, Deno or edge runtimes.
- **React helpers** (`@maxxing/wallet-sdk/react`): React 18 or newer. React is optional for everything else.
- **TypeScript:** types are included. No `@types` package is needed.

## 1. Register your app

Sign in at [developers.maxxing.ad](https://developers.maxxing.ad) with Google or your MAXXING wallet. Create an app and list the
websites it runs on (`https://` addresses, no wildcards, no paths). You get an **app id** (`app_…`). It is public, not a secret.

**Test mode while your app is reviewed.** MAXXING reviews every new app. Until then:

- Add `http://localhost:<port>` or `http://127.0.0.1:<port>` to your websites. The wallet window and the Data API answer your app
  there, and only there.
- Reads, the live stream and webhooks work. Earnings don't: an app in review never becomes a trader's inviter.
- Once your app is live, your `https://` websites work and localhost stops.

## 2. Install

```bash
npm install @maxxing/wallet-sdk
```

**No build step?** Add one script and one tag. The button, account menu and wallet come with it:

```html
<script src="https://developers.maxxing.ad/sdk/0.2.1/maxxing-wallet.js"></script>
<maxxing-connect app-id="app_your_app_id" chains="8453" mode="auto" accent="#7C3AED"></maxxing-connect>
<script>
  const el = document.querySelector("maxxing-connect");
  el.addEventListener("maxxing:connect", e => console.log("connected", e.detail.evm));
  // el.wallet is the full wallet: el.wallet.ethereum.request({ method: "personal_sign", ... })
</script>
```

- **Pin a version in production**, as above. A published version never changes and stays online.
  `https://developers.maxxing.ad/sdk/v0/maxxing-wallet.js` always loads the newest 0.x release.
- **Attributes:** the connect button's options (`label`, `size`, `align`, `show-network`, `show-solana`, `show-mark`) and theme
  values (`mode`, `accent`, `accent-text`, `background`, `surface`, `text`, `muted`, `border`, `radius`, `font`).
- **Events:** `maxxing:connect`, `maxxing:disconnect` and `maxxing:error`.
- The script also sets `window.MaxxingWallet` with everything this package exports.

## 3. Connect

### JavaScript

```js
import { createMaxxingWallet } from "@maxxing/wallet-sdk";

const wallet = createMaxxingWallet({
  appId: "app_your_app_id",
  chains: [8453], // Base. List the networks your app uses.
});

// Call from a click: browsers only open the wallet window from one.
connectButton.onclick = async () => {
  const { evm, solana } = await wallet.connect();
  const signature = await wallet.ethereum.request({
    method: "personal_sign",
    params: ["Sign in to my app", evm],
  });
};
```

### React

```tsx
import { MaxxingProvider, ConnectButton } from "@maxxing/wallet-sdk/react";

export function App() {
  return (
    <MaxxingProvider appId="app_your_app_id">
      <ConnectButton />
    </MaxxingProvider>
  );
}
```

Hooks for the user, balances, signing and sending are in [React](#react).

### wagmi

`createMaxxingWallet` announces the provider with EIP-6963, so wagmi's `injected()` discovery, RainbowKit and Web3Modal list
**MAXXING Wallet** by themselves. To target it directly:

```ts
import { createMaxxingWallet } from "@maxxing/wallet-sdk";
import { createConfig, http, injected } from "wagmi";
import { base } from "wagmi/chains";
import type { EIP1193Provider } from "viem";

const wallet = createMaxxingWallet({ appId: "app_your_app_id", chains: [8453] });

export const config = createConfig({
  chains: [base],
  connectors: [
    injected({
      target: () => ({ id: "ad.maxxing.wallet", name: "MAXXING Wallet", provider: wallet.ethereum as EIP1193Provider }),
    }),
  ],
  transports: { [base.id]: http() },
});
```

### viem

```ts
import { createWalletClient, custom } from "viem";
import { base } from "viem/chains";

const client = createWalletClient({ chain: base, transport: custom(wallet.ethereum) });
const [account] = await client.requestAddresses();
const hash = await client.sendTransaction({ account, to: "0x…", value: 1n });
```

### Solana

```ts
import { createMaxxingWallet } from "@maxxing/wallet-sdk";

// Registers "MAXXING Wallet" with the Wallet Standard. @solana/wallet-adapter picks it up automatically.
createMaxxingWallet({ appId: "app_your_app_id" });
```

Supports `standard:connect` (including `silent`), `standard:disconnect`, `standard:events`, `solana:signMessage` and
`solana:signTransaction` (legacy and v0). Your app sends signed transactions itself; the wallet adapter does this for you.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `appId` | required | Your app id. |
| `chains` | every MAXXING mainnet | EVM chain ids your app uses. A test network is offered only when you list it here. |
| `defaultChainId` | first of `chains` | The network to start on. Without `chains`, the first mainnet in the MAXXING network list. |
| `rpcUrls` | public endpoints | `{ [chainId]: string[] }`: your own endpoints for reads and fees, tried first. |
| `solanaChains` | Solana mainnet | Wallet Standard ids, e.g. `["solana:mainnet"]`. Add `"solana:devnet"` to offer the test network. |
| `announce` | `true` | Announce to EIP-6963 and Wallet Standard apps. |
| `dialog` | `true` | Show a small "continue in the wallet" dialog on your page while the wallet window is open, with an "Open wallet" button if the browser blocked it. |
| `theme` | MAXXING dark | Colors, corners and font for the connect button and the waiting dialog. See [Connect button](#connect-button). |
| `appearance` | your dashboard design | The wallet window's sign-in look for this page. See [Wallet window](#wallet-window). |
| `walletUrl` | `https://wallet.maxxing.ad` | Only for local development of the wallet itself. |

## Sign in with Google, X, TikTok and more

Turn on sign-in methods on your app's **Sign-in methods** tab at [developers.maxxing.ad](https://developers.maxxing.ad). The wallet
window then offers "Continue with …" for each one, with "Use a MAXXING wallet" below. A person who signs in with a provider gets
one MAXXING wallet for your app, created on their device behind a PIN.

- **MAXXING's sign-in app or your own.** Each method can use MAXXING's provider app (quickest) or your own OAuth client, so
  Google, X or TikTok shows *your* app's name and logo. For your own client, add the redirect URL shown on the card
  (`https://api.maxxing.ad/v1/social/oauth/<provider>/callback`) to your provider app and paste its client id and secret.
  Secrets are stored encrypted and never shown again.
- **Providers:** Google, X, TikTok, Discord, GitHub, Twitch, Microsoft, LinkedIn, Facebook, Instagram, Threads, Reddit, Spotify,
  Snapchat, Pinterest, GitLab, Patreon, Kick, LINE, Kakao and Dribbble. The dashboard shows which ones MAXXING's sign-in app
  offers today.

```js
// From a click.
const { connection, user, identityToken } = await wallet.signIn();
user.id;        // "mxu_…": this person's id for your app
user.accounts;  // [{ provider: "google", username: "jean@example.com", name: "Jean", avatar: "https://…", … }]
connection.evm; // their wallet

// Later in the session:
wallet.user;           // the same user, or null
wallet.identityToken;  // valid for an hour; call signIn() again for a new one
```

Send the identity token to your server and check it there. It is an Ed25519 JWT signed by MAXXING, for your app only:

```ts
import { verifyIdentityToken } from "@maxxing/wallet-sdk/server";

const user = await verifyIdentityToken(identityToken, { appId: "app_your_app_id" });
user.sub;      // their id for your app
user.wallet;   // { evm, solana }
user.accounts; // verified accounts they signed in with
```

Public keys: `https://api.maxxing.ad/v1/wallet-apps/.well-known/jwks.json`. Any JWT library that supports EdDSA can check the
token too (issuer `https://api.maxxing.ad`, audience your app id).

`wallet.connect()` never asks for the PIN. `signIn()` opens the wallet if needed, so you always get a token.

## Connect button

A ready-made button in your brand: "Connect wallet" first, then an account button with the address and network, and a menu to copy
addresses, switch networks and disconnect. It lives in its own shadow root, so your CSS can't break it. The
[widget builder](https://developers.maxxing.ad/wallet-widget) writes this code for you.

```js
const wallet = createMaxxingWallet({
  appId: "app_your_app_id",
  chains: [8453],
  theme: { mode: "light", accent: "#7C3AED", accentText: "#ffffff", radius: 999, font: "inherit" },
});

const button = wallet.mountConnectButton("#wallet", {
  label: "Connect wallet",
  size: "md",            // "sm" | "md" | "lg"
  align: "end",          // the menu lines up with the button's right edge
  showNetwork: true,     // network on the button, switching in the menu
  showSolana: true,      // Solana address in the menu
  showMark: true,        // MAXXING mark on the connect button
  onConnect: ({ evm, solana }) => console.log("connected", evm),
  onDisconnect: () => console.log("disconnected"),
  onError: error => console.error(error), // not called when the user cancels
});

button.update({ theme: { mode: "dark" } }); // restyle live
button.destroy();                            // remove it
```

| Theme value | Description |
| --- | --- |
| `mode` | `"dark"` or `"light"`: the starting palette. Every value below overrides it. |
| `accent`, `accentText` | The connect button and highlights, and the text on them. |
| `background`, `surface`, `text`, `muted`, `border` | The account button, menu and dialog. |
| `radius` | Corners in px, 0 to 28. |
| `font` | A CSS font-family list, or `"inherit"` for your page's font. |

Colors take hex, `rgb()`, `hsl()`, `oklch()` or a color name. Anything else falls back to the palette, so a typo never breaks the
button. A `theme` given to `createMaxxingWallet` also styles the waiting dialog; one given to `mountConnectButton` styles that
button only.

## Wallet window

The window people sign in with is styled per app: theme, accent, corners, font, logo, texts and button order. Design it on your
app's **Wallet window** tab at developers.maxxing.ad (with a live preview of the real window), or per page in code. Fields you pass
here win; the rest come from the dashboard.

```js
const wallet = createMaxxingWallet({
  appId: "app_…",
  appearance: {
    theme: "light",            // "dark" | "light" | "auto" (follows the device)
    accent: "#7C3AED",         // buttons; the text on them turns black or white to stay readable
    background: "#FFF7ED",     // or null for the theme's own
    radius: "full",            // "none" | "small" | "medium" | "large" | "full"
    font: "rounded",           // "system" | "rounded" | "serif" | "mono"
    logo: "centered",          // your logo: "card" | "centered" | "hidden" (the website asking always shows)
    buttons: "grid",           // sign-in buttons: "list" | "grid" (two per row)
    title: "Welcome to Acme",  // plain words, up to 48 characters; no links or web addresses
    subtitle: "Trade, launch and earn in one place.",
    order: ["google", "twitter", "discord"], // sign-in methods first, in this order
    wallet: "after",           // "Use a MAXXING wallet": "after" | "before" | "hidden"
    termsUrl: "https://acme.example/terms",
    privacyUrl: "https://acme.example/privacy",
  },
});
```

Invalid values are ignored field by field. Your design applies to sign-in only. Screens that connect your app, show a transaction
or ask for a signature keep MAXXING's wording, the website asking and the "Secured by MAXXING" line, so a real request always
looks like one.

## React

One provider at the root, hooks below it.

```tsx
import { MaxxingProvider, ConnectButton, useMaxxing, useToken, usePrices } from "@maxxing/wallet-sdk/react";

<MaxxingProvider appId="app_…" appearance={{ theme: "light", accent: "#7C3AED" }}>
  <ConnectButton signIn showBalance />
  <App />
</MaxxingProvider>

const { ready, connected, user, identityToken, signIn, disconnect } = useMaxxing();
const { chainId, network, networks, switchChain } = useMaxxing();
const { data: token, loading } = useToken("eip155:8453:0x…");
const { prices } = usePrices(ids); // keyed by token id, refreshed every 15 s
```

Wallet reads and actions. Reading hooks (`useBalance`, `useTransactionReceipt`, `useToken`) return `{ data, error, loading, refresh }`.
Action hooks return `{ data, error, pending, reset }` plus the action, which also returns a promise:

```tsx
const { data: balance } = useBalance();                             // native coin, current network, every 15 s
const { data: usdc } = useBalance({ token: "0x…", chainId: 8453 }); // any ERC-20: value (bigint), formatted, symbol, decimals

const { signMessage, data: signature } = useSignMessage();
await signMessage("Hello");                                         // connects first if needed

const { sendTransaction, data: hash, pending } = useSendTransaction();
await sendTransaction({ to, value: parseUnits("0.01"), chainId: 8453 }); // switches network first
const { data: receipt } = useTransactionReceipt(hash);              // null while pending, then { status, blockNumber, … }

const { signTypedData } = useSignTypedData();                       // EIP-712; bigint values are fine
```

Without React, the same actions are `readBalance`, `signMessage`, `sendTransaction`, `waitForReceipt`, `formatUnits` and
`parseUnits` from `@maxxing/wallet-sdk`.

Safe with server rendering: the wallet starts in the browser, and `ready` turns true once it has.

## Data API

Tokens (MAXXING and outside tokens, in one shape), bulk prices, charts, trades, holders and wallets, fully typed:

```js
import { createMaxxingData, formatUsd } from "@maxxing/wallet-sdk/data";

const data = createMaxxingData({ appId: "app_…" });                        // in a web page
// const data = createMaxxingData({ secret: process.env.MAXXING_APP_SECRET }); // on a server

const { items } = await data.tokens({ sort: "trending", origin: "all", limit: 20 });
const token = await data.token(items[0].id);                                // every token has an id: "<chainId>:<address>"
const prices = await data.prices(items.map(t => t.id));                     // 25 per call, batched for you
const { items: candles } = await data.candles(token.id, { interval: "1h", limit: 200 });
const { items: positions } = await data.wallet("0x…").positions({ state: "open" });
const { items: held, totalUsd, complete } = await data.wallet("0x…").balances(); // complete: false = MAXXING tokens only for now
const stop = data.watchPrices(ids, prices => render(prices));               // every 15 s while the page is visible
for await (const t of data.all(cursor => data.tokens({ cursor }))) { /* every page */ }
```

- **Keys.** A web page uses the app id, accepted only from one of your websites; each visitor has their own per-minute limit. A
  server uses the secret (`Authorization: Bearer mxsk_…`). Never ship the secret to a browser.
- **Limits.** Every answer carries `x-ratelimit-limit` and `x-ratelimit-remaining` (per minute), and `x-quota-limit` and
  `x-quota-remaining` (per month, your plan).
- **Errors** are `MaxxingDataError` with a stable `code` (`RATE_LIMITED`, `MONTHLY_QUOTA_REACHED`, `NOT_FOUND`, …), `status` and
  `retryAfter`. A short `429` is retried once by itself. Every code: [developers.maxxing.ad/errors](https://developers.maxxing.ad/errors).
- **Reference.** Every endpoint, with "Try it": [developers.maxxing.ad/api](https://developers.maxxing.ad/api). The source of truth
  is `https://api.maxxing.ad/v1/public/openapi.json`.

## Live updates

One connection (`wss://api.maxxing.ad/v1/public/stream`) for up to 50 tokens, which reconnects by itself:

```js
const stop = data.subscribe([tokenId], {                    // data from createMaxxingData; ids from the Data API
  onPrice: p => render(p.id, p.priceUsd, p.change24hPct),   // as the token's numbers move
  onTrades: id => data.trades(id).then(showTrades),         // new trades landed
});
```

- `usePrices`, `useTrades`, `watchPrices` and the trade widget already use it. Where no live connection can open, the same
  callbacks run from a check every 15 s.
- **Servers** pass a socket that sends the secret, for example with the `ws` package:
  `createMaxxingData({ secret, socket: url => new WebSocket(url, { headers: { authorization: "Bearer " + secret } }) })`.
- **Raw protocol:** send `{"op":"subscribe","tokens":[ids]}`; receive
  `{"type":"price",id,priceUsd,change24hPct,marketCapUsd,volume24hUsd,liquidityUsd,asOf}` and `{"type":"trades",id}`. Web pages
  connect with `?app=<appId>` from one of the app's websites (localhost while in review).

## Trade widget

A card for one token: live price and chart, with buy and sell from the user's own MAXXING wallet. Your app can earn on the trades
it brings.

```js
const { items } = await data.tokens({ origin: "maxxing", sort: "trending", limit: 1 });
wallet.mountTradeWidget("#trade", {
  token: items[0].id,                                  // any token id from the Data API
  amounts: [10, 25, 50, 100],                          // buy chips, in USD
  theme: { mode: "light", accent: "#7C3AED" },         // same theme as the connect button
  onTrade: ({ side, hash, chainId }) => console.log(side, hash),
});
```

```tsx
<TradeWidget token={id} amounts={[10, 25, 50, 100]} /> // inside <MaxxingProvider>
```

- **MAXXING tokens** trade right in the card: an approval when needed, then the trade, each confirmed in the wallet window, and the
  card follows it until it lands.
- **Tokens that trade through MAXXING Cash** (outside tokens and Solana) show a button to the MAXXING token page, with your app as
  the inviter.
- **Earnings.** Set an earnings wallet on your app's **Earnings** tab. When a trader with no inviter makes their first buy through
  your live app, that wallet becomes their inviter for good once the buy lands. From then on it earns the inviter share of
  MAXXING's trading fee on every MAXXING trade they make. The Earnings tab shows the current rates. Traders who already have an
  inviter keep theirs. No extra signature or transaction is needed.

**Without the card:** `data.tradeQuote({ token, side: "BUY", wallet, amountUsd: 25 })` (or `POST /v1/public/trade/quote`) returns
either `transactions` to send from the user's wallet, or `mode: "page"` with a `tradeUrl`. It adds `blockingReason` when the trade
can't go ahead (`INSUFFICIENT_QUOTE_BALANCE`, `SELL_AMOUNT_EXCEEDS_POSITION`, …). A buy under the chain's smallest buy answers
`409 BELOW_MIN_BUY` with `minBuyUsd`. On a buy, `referral` is `"pending"` (your live app becomes the trader's inviter once it
lands), `"existing"` (they already have one) or `null`.

## Content-Security-Policy

If your site sets a CSP, allow what the SDK talks to:

- `connect-src https://api.maxxing.ad wss://api.maxxing.ad` (Data API, stream, sign-in), plus the chain RPC hosts.
  `browserRpcOrigins()` from `@maxxing/wallet-sdk` lists the public ones the SDK uses, or pass your own `rpcUrls`.
- No `frame-src` is needed: the wallet opens in its own window on `wallet.maxxing.ad`.

## EIP-1193 requests

| Request | Behavior |
| --- | --- |
| `eth_requestAccounts`, `wallet_requestPermissions` | Connect (wallet window, once). |
| `eth_accounts`, `eth_chainId`, `net_version`, `wallet_getPermissions` | Answered on your page. |
| `wallet_revokePermissions` | Disconnect on this site. |
| `wallet_switchEthereumChain`, `wallet_addEthereumChain` | Switch between your `chains`; others fail with `4902`. |
| `personal_sign`, `eth_signTypedData_v4` | The wallet window shows the message or the typed data, with a warning for permits. |
| `eth_sendTransaction`, `eth_signTransaction` | Prepared on your page (nonce, gas, fees), confirmed in the wallet window with the network, amount and highest possible fee, then sent. |
| `eth_call`, `eth_getBalance`, other read-only `eth_*` | Sent to the network. |
| `eth_sign` | Refused (`4200`). |

Events: `connect`, `disconnect` (with a `4900` error), `accountsChanged` and `chainChanged`.

## Errors

Errors are `ProviderRpcError`s with EIP-1193 codes:

| Code | Meaning |
| --- | --- |
| `4001` | The user cancelled or closed the wallet. |
| `4100` | Not connected, or the user switched wallets. The provider disconnects; connect again. |
| `4200` | Not supported. |
| `4900` | Disconnected (the `disconnect` event). |
| `4902` | Network not supported. |

## Server API

Create a server secret on your app's **Keys** tab. It is shown once, and creating a new one stops the old one at once. Use it in
server code for the Data API, the live stream, trade quotes and your usage. Usage is your app's daily count of new connections and
signatures; `days` is 1 to 90 (default 30). Nothing about who your users are is recorded.

```bash
curl "https://api.maxxing.ad/v1/wallet-apps/app_your_app_id/usage?days=30" \
  -H "Authorization: Bearer $MAXXING_APP_SECRET"
```

```json
{ "app": "app_your_app_id", "days": [{ "day": "2026-11-08", "connections": 12, "signatures": 40 }] }
```

## Webhooks

MAXXING can call your server when something happens. Add an endpoint on your app's **Webhooks** tab: an `https://` URL, the events
and the tokens it follows (up to 50, with ids from the Data API). Each app can have up to 5 endpoints.

| Event | When | `data` |
| --- | --- | --- |
| `trade.created` | A trade on a token the endpoint follows (for outside tokens, MAXXING users' trades only) | `token`, `txHash`, `time`, `side`, `trader`, `amountUsd`, `priceUsd` (the Data API's trade) |
| `webhook.test` | You press **Send test** | `webhook`, `message` |

Each call is a `POST` with the JSON body `{ id, type, createdAt, data }`, signed with your endpoint's secret (`whsec_…`) as
[Standard Webhooks](https://www.standardwebhooks.com) define: headers `webhook-id`, `webhook-timestamp` and `webhook-signature`.
Check it with `verifyWebhook` or any Standard Webhooks library:

```ts
import express from "express";
import { verifyWebhook } from "@maxxing/wallet-sdk/server";

app.post("/maxxing", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try { event = verifyWebhook(process.env.MAXXING_WEBHOOK_SECRET!, req.headers, req.body.toString("utf8")); }
  catch { return res.sendStatus(400); }
  if (event.type === "trade.created") console.log(event.data.side, event.data.amountUsd, event.data.token);
  res.sendStatus(200);
});
```

- **Pass the body exactly as it arrived.** A parsed and re-written body won't match the signature.
- **Answer `2xx` within 10 seconds.** Anything else is retried after 30 s, 2 min, 10 min, 1 h, 3 h, 6 h and 12 h. The dashboard
  shows every call for 14 days and can send one again.
- **Drop repeats by `id`.** The same event can arrive more than once and out of order; its `id` stays the same on every retry.
- **Coverage.** Trades are sent from when the endpoint starts following a token. A trade first seen more than 15 minutes late isn't
  sent, and one burst sends at most a token's newest 1,000 trades. For a full history, page the Data API's trades.
- Webhooks work in test mode too. An endpoint that fails every call for 3 days is switched off; turn it back on in the dashboard.
- Calls only go to public addresses and never follow redirects.

## Verifying a wallet sign-in on your server

A connected address alone proves nothing to your server. To sign someone in, your server writes a one-time Sign-In with Ethereum
message (EIP-4361) naming your site, the address, a nonce and an expiry. The user signs it in the wallet window, which shows it as
"Sign in to your-site.com" and refuses it if your site isn't the one named. Your server then checks it:

```ts
// Your server (Node 18+, Bun, Deno, edge runtimes).
import { createSignIn, verifySignIn, SignInError } from "@maxxing/wallet-sdk/server";

const DOMAIN = "app.example.com";          // your site's host ("localhost:3000" in development)
const URI = "https://app.example.com";
const pending = new Map<string, string>(); // nonce -> message. Use your database in production.

// POST /auth/nonce { address, chainId }
export function start(address: string, chainId: number) {
  const { message, nonce } = createSignIn({ domain: DOMAIN, uri: URI, address, chainId, statement: "Sign in to Example." });
  pending.set(nonce, message);
  return { nonce, message };
}

// POST /auth/verify { nonce, signature }
export function finish(nonce: string, signature: string) {
  const message = pending.get(nonce);
  pending.delete(nonce); // each nonce works once
  if (!message) throw new Error("UNKNOWN_NONCE");
  try {
    const { address } = verifySignIn({ message, signature, domain: DOMAIN, nonce });
    return address; // start your own session for this address
  } catch (error) {
    if (error instanceof SignInError) throw new Error(error.code); // WRONG_DOMAIN, EXPIRED, BAD_SIGNATURE, …
    throw error;
  }
}
```

```ts
// Your site. `post` is your JSON fetch helper.
const { evm } = await wallet.connect(); // from a click
const chainId = Number(await wallet.ethereum.request({ method: "eth_chainId" }));
const { nonce, message } = await post("/auth/nonce", { address: evm, chainId });

// From a second click ("Sign in"), so the browser lets the wallet window open.
const signature = await wallet.ethereum.request({ method: "personal_sign", params: [message, evm] });
await post("/auth/verify", { nonce, signature });
```

- **Solana** works the same way: `createSignIn({ …, address: solanaAddress, family: "solana" })`, sign the message bytes with the
  wallet adapter's `signMessage`, and pass the base58 signature to `verifySignIn`.
- **`nonce` is required** (since 0.2.0). Without the nonce you stored, the same signed message could be accepted again.
- The helper checks the domain, nonce, time window and signature (secp256k1 for EVM, ed25519 for Solana, with the audited `@noble`
  libraries). It verifies the message you stored, never one the browser sends back. `parseSignInMessage` reads any EIP-4361 message
  if you need its fields.

## Security

- **Keys stay in the wallet.** The wallet creates and keeps keys on the user's device. Your site and this SDK only ever get
  addresses and signatures, never a private key or recovery phrase.
- **Only your websites.** The wallet answers your app only from the websites you registered, checked against the browser's own
  record of who sent each message: localhost only while the app is in review, its `https://` websites once live.
- **Reviewed apps.** Every app is reviewed before it goes live; while in review, the wallet window marks it as not reviewed yet.
  Changes to a live app's name, logo or websites are reviewed too, and the app keeps working with its current details meanwhile.
- **Users stay in control.** They approve each app once per wallet, see every request in the wallet's own window, and can remove
  connected apps at `wallet.maxxing.ad/apps.html`.
- **Risky requests refused.** `eth_sign` is not offered, and a text message that is really a Solana transaction is refused.
- **Small, pinned dependencies.** The package depends on six exact-version libraries (`@noble/curves`, `@noble/hashes`, `bs58` and
  the Wallet Standard types) and runs no install scripts.

Found a vulnerability? Email [support@maxxing.ad](mailto:support@maxxing.ad) with "Security" in the subject. Please don't post it
publicly first.

## Versioning

The SDK follows semantic versioning. Before 1.0, a minor version (0.x.0) may change an API; a patch (0.x.y) never does. See the
[changelog](https://developers.maxxing.ad/changelog) and the [versioning policy](https://developers.maxxing.ad/versioning).

## Support

- Docs and guides: [developers.maxxing.ad/docs](https://developers.maxxing.ad/docs)
- API reference: [developers.maxxing.ad/api](https://developers.maxxing.ad/api)
- Email: [support@maxxing.ad](mailto:support@maxxing.ad)

## License

MIT © MAXXING
