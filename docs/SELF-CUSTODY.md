# Self-custody in the MAXXING wallet

The MAXXING wallet is **self-custodial** (non-custodial): your recovery phrase and private keys are created on your device, are
kept there encrypted, and are used there to sign. **MAXXING never has your keys**, has no copy it could restore, and cannot sign for
you. What leaves your device is your public addresses and the signatures you approve.

This page says exactly how that works, what still depends on MAXXING, and how to check every claim yourself. It covers the web
wallet at `wallet.maxxing.ad` ([`apps/wallet`](../apps/wallet), [`packages/core`](../packages/core)). File references are to this
repository.

## How your keys are made

- **Entropy.** A new wallet is a 12-word BIP-39 recovery phrase (128 bits) from the browser's cryptographic random number generator
  (`crypto.getRandomValues`, through `@scure/bip39`). [`packages/core/src/derive.ts`](../packages/core/src/derive.ts)
- **Keys.** Both keys come from that one phrase: EVM at `m/44'/60'/0'/0/0` (BIP-32, secp256k1) and Solana at `m/44'/501'/0'/0'`
  (SLIP-0010, ed25519). The same phrase restores the same addresses in any wallet that uses these standard paths.
- **Restore.** Importing a phrase derives the same keys on the new device. Nothing is fetched from MAXXING to do it.

## Where they are kept, and how they are encrypted

Everything below lives in your browser's storage for `wallet.maxxing.ad` (localStorage and IndexedDB), on your device only.
[`packages/core/src/vault.ts`](../packages/core/src/vault.ts), [`device-session.ts`](../packages/core/src/device-session.ts)

| What | How it is protected |
| --- | --- |
| Recovery phrase | Encrypted with AES-256-GCM under a random 256-bit **data key** made for this wallet. The ciphertext is bound (as additional data) to the wallet's id and both addresses, so it can't be swapped onto another wallet. |
| Data key, PIN copy | Wrapped with AES-256-GCM under a key from your **6-digit PIN**: PBKDF2-HMAC-SHA-256, 600,000 iterations, random 128-bit salt. The PIN itself is never stored. |
| Data key, passkey copy (optional) | Wrapped with AES-256-GCM under a key from your **passkey's PRF output** (WebAuthn, user verification required: Face ID, Touch ID, Windows Hello or a security key), through HKDF-SHA-256 bound to the wallet and the credential. |
| Data key, "stay signed in" copy | Wrapped with AES-256-GCM under a **non-extractable** key the browser keeps in IndexedDB: page code can use it but never read it out. Signing out deletes it. |
| Keys while the wallet is open | In memory only, inside the wallet window. Wiped on sign-out, on switching wallet and when the page closes. |

Wrong PINs make you wait: 30 seconds after the fifth, then twice as long each time, up to an hour. You are never locked out.

**What the PIN does and doesn't protect.** A 6-digit PIN keeps the wallet closed to someone using your unlocked browser after you
sign out. It is not meant to stop someone who has already copied your browser's storage: such an attacker can try all million PINs
offline, and each try costs 600,000 PBKDF2 rounds. Keep your device and browser profile secure, and keep your recovery phrase
offline. A passkey adds a hardware-backed way in, but the PIN copy remains.

## What leaves your device

| Sent | To | When |
| --- | --- | --- |
| Your EVM and Solana addresses | the app you connect, and MAXXING's API | connecting, signing in |
| Signatures you approve | the app that asked | each request |
| An app sign-in: addresses, a nonce, a timestamp and two signatures over a readable message | MAXXING's API | signing in to an app through the wallet window |
| The unsigned transaction and your address, for a balance check and a simulated preview | MAXXING's read-only RPC relay | when the window shows you a transaction |
| The app's id, and the words "connect" or "sign" | MAXXING's API (usage counts for the app's developer) | connecting, signing |

Never sent: the recovery phrase, any private key, the data key, the PIN, the passkey's PRF output, or the encrypted vault. There is
no server-side backup of your wallet: linking a social account links your **addresses** only, and a new device restores from your
recovery phrase.

## What MAXXING can never do with your wallet

- Read, export or restore your recovery phrase or keys. MAXXING has no copy.
- Sign a message or transaction from your account on its servers. MAXXING's servers verify your signatures; they hold nothing
  that can make them. Every signature is made by your wallet, on your device.
- Freeze, move or recover what is in your wallet from its side. Your addresses are ordinary EVM and Solana accounts, controlled by
  your keys.

What your open wallet signs is decided by the code running in your browser and by you. That is why the next section matters.

## What still depends on MAXXING: trust points, stated plainly

1. **The code that runs.** `wallet.maxxing.ad` is a website: your browser runs the JavaScript MAXXING serves at the moment you open
   it. Its source is `apps/wallet` here, and deployments are moving to build directly from this repository so that each one
   corresponds to a public commit anyone can rebuild and compare. Even then, a web user trusts each deployed version as it loads. The MAXXING browser extension, built reproducibly from tagged public code and installed once, is
   meant to remove this trust point for people who use it.
2. **maxxing.ad's own requests are not prompted.** On maxxing.ad, the wallet runs in a hidden frame that, once you have unlocked
   it, signs maxxing.ad's requests without a confirmation screen: EVM messages, typed data, transactions and EIP-7702
   authorizations (to the one contract below only), and Solana messages and transactions
   ([`apps/wallet/src/main.ts`](../apps/wallet/src/main.ts)). This is the first-party experience, and it means the code served on
   `maxxing.ad`, which is not in this repository, can have your open wallet sign. The frame never gives out your keys or phrase. Partner sites never get this:
   every request from another site is shown to you in the wallet window first. The list of sites with this access is in
   [`apps/wallet/src/registry.ts`](../apps/wallet/src/registry.ts); a production build accepts https sites only.
3. **One delegation contract.** Gasless trades on EVM use EIP-7702: your account may delegate to exactly one contract,
   `0x000000009B1D0aF20D8C6d0A44e162d11F9b8f00` (Relay's Calibur), and the wallet refuses any other
   ([`packages/core/src/signing.ts`](../packages/core/src/signing.ts)). MAXXING's code adds no key of its own to a delegated account;
   it only has batches of calls you signed submitted. That contract is Relay's, not MAXXING's: review it on chain.
4. **Network data you are shown.** Balances and transaction previews come through MAXXING's read-only RPC relay. A wrong answer
   could show you a wrong preview; it can't sign anything. What you sign is always the request itself, decoded on your device.
5. **Contracts are a separate topic.** Self-custody covers your wallet. Tokens, pools and fee modules launched through MAXXING are
   smart contracts with their own rules: for example, owner-set fee routes, verifiers for social claims and holder rewards, and
   settings for future launches. Those powers never include taking assets out of your wallet; they are documented with the
   contracts. Check who holds each owner role on chain.

## How to check it yourself

- **Read the code.** Key creation, encryption and signing are in [`packages/core/src`](../packages/core/src); what each screen shows
  and sends is in [`apps/wallet/src`](../apps/wallet/src).
- **Run the tests.** `pnpm --filter @maxxing/wallet-core test` and `pnpm --filter @maxxing/wallet-frame test`. Among them:
  - [`packages/core/tests/no-leak.test.ts`](../packages/core/tests/no-leak.test.ts) creates, opens, signs with, re-keys, restores and
    removes wallets with every network API and the console trapped, and fails if any is used or if storage holds a secret in
    readable form. It also fails if any core file references the network or the console.
  - [`apps/wallet/tests/no-leak.test.ts`](../apps/wallet/tests/no-leak.test.ts) records every request the wallet window sends while
    a wallet is open, fails if any carries the phrase, a key or the PIN, and fails if a new file starts using the network without
    review.
- **Watch the network.** Open `wallet.maxxing.ad` with your browser's developer tools (Network tab) and use the wallet. The pages'
  Content-Security-Policy ([`apps/wallet/vercel.json`](../apps/wallet/vercel.json)) is enforced by your browser: the hidden frame
  may contact no server at all (`connect-src 'self'`), and the wallet window only `api.maxxing.ad`.
- **Rebuild and compare.** Check out the commit a deployment came from and run `pnpm install --frozen-lockfile` and
  `pnpm --filter @maxxing/wallet-frame build`. Compare `apps/wallet/dist` with the files `wallet.maxxing.ad` serves (for example
  `sha256sum` of each file under `/assets/`).
- **The SDK.** `@maxxing/wallet-sdk` on npm carries provenance linking it to the commit and workflow run that built it
  (`npm audit signatures`).

Found something that doesn't match this page? Please tell us privately: [SECURITY.md](../SECURITY.md).
