# Self-custody in the MAXXING wallet

The MAXXING wallet is **self-custodial**. Your recovery phrase and private keys are created on your device, kept there encrypted,
and used there to sign. **MAXXING never has your keys** and holds no copy it could restore. By default, nothing is signed until
you approve it on the wallet's own approval screen.

This page explains how that works, what still depends on MAXXING, and how to check each claim yourself. It covers the web wallet
at `wallet.maxxing.ad`: [`apps/wallet`](../apps/wallet) and [`packages/core`](../packages/core). File links point into this
repository.

- [How your keys are made](#how-your-keys-are-made)
- [Where they are kept](#where-they-are-kept)
- [You approve every signature](#you-approve-every-signature)
- [What leaves your device](#what-leaves-your-device)
- [What MAXXING cannot do](#what-maxxing-cannot-do)
- [What still depends on MAXXING](#what-still-depends-on-maxxing)
- [How to check it yourself](#how-to-check-it-yourself)

## How your keys are made

- **Entropy.** A new wallet starts as a 12-word BIP-39 recovery phrase (128 bits), drawn from the browser's cryptographic random
  number generator (`crypto.getRandomValues`, through `@scure/bip39`).
  [`packages/core/src/derive.ts`](../packages/core/src/derive.ts)
- **Keys.** Both keys come from that one phrase: the EVM key at `m/44'/60'/0'/0/0` (BIP-32, secp256k1) and the Solana key at
  `m/44'/501'/0'/0'` (SLIP-0010, ed25519). Any wallet that uses these standard paths restores the same addresses from the phrase.
  The seed and intermediate keys are overwritten with zeros after use.
- **Restore.** Entering your phrase on a new device derives the same keys there. Nothing is fetched from MAXXING to do it. An
  encrypted backup file made by an earlier version of the wallet still restores, with the password chosen for that file; the
  wallet no longer creates these files.

## Where they are kept

Everything below lives in your browser's storage for `wallet.maxxing.ad` (localStorage and IndexedDB), on your device only.
[`packages/core/src/vault.ts`](../packages/core/src/vault.ts),
[`packages/core/src/device-session.ts`](../packages/core/src/device-session.ts)

| What | How it is protected |
| --- | --- |
| Recovery phrase | Encrypted with AES-256-GCM under a random 256-bit **data key** made for this wallet. The ciphertext is bound (as additional authenticated data) to the wallet's id and both addresses, so it can't be moved onto another wallet. |
| Data key, PIN copy | Wrapped with AES-256-GCM under a key derived from your **6-digit PIN**: PBKDF2-HMAC-SHA-256, 600,000 iterations, random 128-bit salt. The PIN itself is never stored. |
| Data key, passkey copy (optional) | Wrapped with AES-256-GCM under a key derived from your **passkey's PRF output** (WebAuthn with user verification required: Face ID, Touch ID, Windows Hello or a security key), through HKDF-SHA-256 bound to the wallet and the credential. |
| Data key, "stay signed in" copy | Wrapped with AES-256-GCM under a **non-extractable** key the browser keeps in IndexedDB. Page code can use this key but can never read it out. Signing out deletes it. |
| Keys while the wallet is open | In memory only, inside the wallet's page. When you sign out, switch wallets or close the page, the key bytes are overwritten with zeros and released. The phrase is a JavaScript string, which can't be overwritten; it is released and left for the browser to reclaim. |

After five wrong PINs you wait 30 seconds, and each further wrong PIN doubles the wait, up to one hour. You are never locked out.

**What the PIN protects, and what it doesn't.** The PIN keeps the wallet closed to someone who uses your browser after you sign
out. It does not stop an attacker who has already copied your browser's storage: they can try all one million PINs offline, at a
cost of 600,000 PBKDF2 rounds per try. Keep your device and browser profile secure, and keep your recovery phrase offline. A
passkey adds a hardware-backed way in, but the PIN copy always remains.

## You approve every signature

By default, every signing request, whether from maxxing.ad or any other site, opens the wallet's approval screen first. The screen
shows who is asking and what the request does in plain words: the network, the amounts and the highest fee it can cost. It warns
about risks such as unlimited token approvals or a sign-in message meant for a different site. Nothing is signed until you press
Approve, and Decline signs nothing.

What is signed is exactly what was shown. A transaction is checked field by field before it is displayed, and a request the
screen can't show faithfully is refused.
[`apps/wallet/src/consent.ts`](../apps/wallet/src/consent.ts),
[`packages/core/src/review.ts`](../packages/core/src/review.ts)

**One-tap trading (optional, off by default).** For fast trading on maxxing.ad, you can turn on one-tap trading for a wallet in
the wallet's own settings, after entering your PIN. While it is on and that wallet is open, maxxing.ad's requests are signed
without a prompt. It never applies to other sites. The setting is stored per wallet on your device, and you can turn it off with
one tap. Nothing maxxing.ad sends can turn it on; only the wallet's own screen can.
[`packages/core/src/approvals.ts`](../packages/core/src/approvals.ts)

## What leaves your device

| What is sent | To | When |
| --- | --- | --- |
| Your EVM and Solana addresses | The site you connect to, and MAXXING's API | Connecting and signing in |
| The signatures you approve | The site that asked | Each approved request |
| An app sign-in: addresses, a nonce, a timestamp and two signatures over a readable message | MAXXING's API | Signing in to an app through the wallet window |
| Social sign-in: a one-time challenge, a nonce and the wallet page's origin to start; a one-time ticket and its verifier to finish | MAXXING's API, and the provider you chose (for example Google) in its own window | "Continue with …" in the wallet window |
| The app's id, to load its public profile, logo and sign-in options | MAXXING's API | Opening the wallet window for an app |
| The app's id and the word "connect" or "sign" (usage counts for the app's developer) | MAXXING's API | Connecting and signing |
| The unsigned transaction and your address, for a balance check and a simulated preview | MAXXING's read-only RPC relay | When the wallet window shows you a transaction |
| A request for public display settings (today, the MAXXING website address). It carries nothing about you or your wallet. | MAXXING's API | Opening the Connected apps page on a device with no wallet |

**Never sent:** the recovery phrase, any private key, the data key, the PIN, the passkey's PRF output, or the encrypted vault.
There is no server-side backup of your wallet. Linking a social account links your **addresses** only, and a new device restores
from your recovery phrase.

## What MAXXING cannot do

- Read, export or restore your recovery phrase or keys. MAXXING has no copy.
- Sign with your keys on its servers. The servers verify your signatures; they hold nothing that can create them.
- Freeze, move or recover the assets in your wallet. Your addresses are ordinary EVM and Solana accounts, controlled by your keys.

What your open wallet signs is decided by you and by the code running in your browser. The next section covers that code.

## What still depends on MAXXING

These are the points where you still rely on MAXXING. We list them so you can judge them for yourself.

1. **The code your browser runs.** `wallet.maxxing.ad` is a website, so your browser runs the JavaScript MAXXING serves at the
   moment you open it. Its source is `apps/wallet` in this repository. Deployments are moving to build directly from this
   repository, so that each one matches a public commit anyone can rebuild and compare. Even then, a web user trusts each deployed
   version as it loads. The MAXXING browser extension, built reproducibly from tagged public code and installed once, is meant to
   remove this trust point for the people who use it.
2. **One-tap trading, if you turn it on.** With one-tap trading on, maxxing.ad's code (which is not in this repository) can have
   your open wallet sign without asking you: EVM messages, typed data, transactions and EIP-7702 authorizations (to the one
   contract in point 4 only), and Solana messages and transactions. With it off, which is the default, maxxing.ad gets nothing
   without your approval. In both cases the wallet never reveals your keys or phrase.
3. **Which site counts as maxxing.ad.** The home site's addresses are built into the wallet
   ([`apps/wallet/src/first-party.ts`](../apps/wallet/src/first-party.ts)), and a production build accepts `https://` addresses
   only. A build can replace the list through the `VITE_WALLET_APPS` setting. Every build publishes the list it uses at
   [`/first-party-apps.json`](https://wallet.maxxing.ad/first-party-apps.json), with `"source": "built-in"` or
   `"source": "VITE_WALLET_APPS"`, and this repository's CI fails if its build does not use the built-in list.
4. **One delegation contract.** Gasless trades on EVM networks use EIP-7702. Your account may delegate to exactly one contract,
   `0x000000009B1D0aF20D8C6d0A44e162d11F9b8f00` (Calibur, by Relay), and the wallet refuses any other
   ([`packages/core/src/signing.ts`](../packages/core/src/signing.ts)). MAXXING's code adds no key of its own to a delegated
   account; it only passes on batches of calls that you signed. The contract belongs to Relay, not MAXXING; you can review it on
   chain.
5. **The network data you see.** Balances and transaction previews come through MAXXING's read-only RPC relay. A wrong answer
   could show you a wrong preview, but it can't sign anything. What you approve is always the request itself, decoded on your
   device.
6. **Contracts are a separate matter.** Self-custody covers your wallet. Tokens, pools and fee modules launched through MAXXING are
   smart contracts with their own rules, such as owner-set fee routes, verifiers for social claims and holder rewards, and settings
   for future launches. None of those powers can take assets out of your wallet. They are documented with the contracts, and you
   can check on chain who holds each owner role.

## How to check it yourself

**Read the code.** Key creation, encryption and signing are in [`packages/core/src`](../packages/core/src). What each screen
shows, asks and sends is in [`apps/wallet/src`](../apps/wallet/src). [Architecture](ARCHITECTURE.md) gives a map.

**Run the tests.**

```bash
pnpm install --frozen-lockfile
pnpm --filter @maxxing/wallet-core test
pnpm --filter @maxxing/wallet-frame test
```

Three of them check the claims on this page directly:

- [`packages/core/tests/no-leak.test.ts`](../packages/core/tests/no-leak.test.ts) creates, opens, signs with, re-keys, restores
  and removes wallets with every network API and the console trapped. It fails if any of them is used, or if storage holds a
  secret in readable form. It also fails if any core file references the network, the console, other windows or workers.
- [`apps/wallet/tests/no-leak.test.ts`](../apps/wallet/tests/no-leak.test.ts) runs every request the wallet window can send while
  a wallet is open and records URLs, headers and bodies, text and binary. It fails if any of them carries the phrase, a key or the
  PIN, and it fails if a file starts using the network, other windows or workers without being reviewed.
- [`apps/wallet/tests/consent.test.ts`](../apps/wallet/tests/consent.test.ts) checks that by default every kind of signature is
  shown and approved first, that declining signs nothing, that what was approved is what was signed, and that one-tap trading can
  be turned on only from the wallet's own screen with the PIN.

**Watch the network.** Open `wallet.maxxing.ad` with your browser's developer tools on the Network tab and use the wallet. Your
browser enforces the pages' Content-Security-Policy, set in [`apps/wallet/vercel.json`](../apps/wallet/vercel.json):

- the embedded frame that maxxing.ad loads may connect only to `wallet.maxxing.ad` itself (`connect-src 'self'`), which serves the
  wallet's static files;
- the wallet window may connect only to `wallet.maxxing.ad` and `api.maxxing.ad`.

**Rebuild and compare.** This proves a deployment once `wallet.maxxing.ad` builds from this repository (trust point 1). Until
then, the deployed files come from the same source but not necessarily the same dependency versions.

1. Check out the deployed commit and build it the way the deployment does: Node 22, pnpm 10, no `VITE_*` variables set.

   ```bash
   pnpm install --frozen-lockfile
   VERCEL_ENV=production pnpm --filter @maxxing/wallet-frame build
   ```

2. Hash every file. This repository's CI prints the same list for every commit, in the "File hashes" step of the `wallet` job.

   ```bash
   cd apps/wallet/dist && find . -type f | sort | xargs sha256sum
   ```

3. Compare with what `wallet.maxxing.ad` serves, for example
   `curl -s https://wallet.maxxing.ad/assets/<file> | sha256sum`, and check that
   `https://wallet.maxxing.ad/first-party-apps.json` says `"source": "built-in"`.

**Check the SDK.** Every `@maxxing/wallet-sdk` release on npm carries provenance that links it to the commit and workflow run that
built it. Run `npm audit signatures` in your project.

If you find anything that doesn't match this page, please tell us privately; see [SECURITY.md](../SECURITY.md).
