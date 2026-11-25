# @maxxing/wallet-core

The MAXXING wallet's key-safety code: how your recovery phrase and keys are made and kept, how the PIN and passkey open them, how
requests are signed, and what you are shown before you sign. The wallet at `wallet.maxxing.ad` runs this exact package; there is
one copy, developed in MAXXING's main repository and copied here file for file.

It is not published to npm. Read it, run its tests, and build it yourself. How this adds up to a self-custodial wallet, and how
to check it, is in [docs/SELF-CUSTODY.md](../../docs/SELF-CUSTODY.md).

## What is in it

| File | What it does |
| --- | --- |
| [`src/derive.ts`](src/derive.ts) | Creates and checks the recovery phrase (BIP-39, 12 words) and derives the EVM key (`m/44'/60'/0'/0/0`) and the Solana key (`m/44'/501'/0'/0'`, SLIP-0010 ed25519) from it. Seeds and intermediate keys are wiped after use. |
| [`src/vault.ts`](src/vault.ts) | The wallets on a device. Each recovery phrase is sealed with its own random 256-bit data key (AES-256-GCM, bound to the wallet's id and addresses). The data key is wrapped by your 6-digit PIN (PBKDF2-SHA-256, 600,000 iterations), optionally by a passkey (WebAuthn PRF output through HKDF), and while you stay signed in by a device key the browser won't reveal. Wrong PINs make you wait longer each time (30 seconds after the fifth, then twice as long each time, up to an hour), never locking you out. Keys live only in memory while the wallet is open; on sign-out, on switching wallet and when the page goes away their bytes are overwritten with zeros and dropped (the phrase, a JavaScript string, is dropped and left to the browser to reclaim). |
| [`src/device-session.ts`](src/device-session.ts) | Keeps a wallet open on this device until sign-out: the data key is wrapped by a non-extractable AES key stored in IndexedDB, which page code can use but never read. |
| [`src/signing.ts`](src/signing.ts) | Signs EVM messages, typed data, transactions and EIP-7702 authorizations, and Solana bytes. Only signatures leave. An account may delegate (EIP-7702) to one contract only, at a fixed address. |
| [`src/solana-tx.ts`](src/solana-tx.ts) | Reads a Solana transaction (legacy or v0) far enough to show what it does, signs it in its own slot, and refuses a transaction disguised as a message. |
| [`src/review.ts`](src/review.ts) | What you are shown before signing: messages as text or bytes, typed data field by field (exactly the signed fields, with a warning on permits and orders), transactions with network, amount and the most the fee can be, token approvals and transfers in words (with a warning on unlimited approvals), and Solana token instructions. A transaction is checked field by field, so what you see is what is signed; anything the screen would show differently is refused. |
| [`src/sign-in.ts`](src/sign-in.ts) | Checks a sign-in message (EIP-4361) against the site asking and the account signing, and its time window. |
| [`src/simulation.ts`](src/simulation.ts) | Reads a simulated transaction into what leaves and arrives in the wallet, and checks the balance against what a transaction can spend. |
| [`src/approvals.ts`](src/approvals.ts) | Which apps each wallet has connected to, per website, and whether the user turned on one-tap trading for the home site (off by default). |
| [`src/chains.ts`](src/chains.ts), [`src/chain-data.generated.ts`](src/chain-data.generated.ts) | The networks and tokens the screens name. Generated from MAXXING's chain registry; public data only. Production builds switch test networks off. |

## Run the tests

```bash
pnpm install --frozen-lockfile
pnpm --filter @maxxing/wallet-core typecheck
pnpm --filter @maxxing/wallet-core test
```

The tests create, open, lock, restore and remove wallets in memory, try wrong PINs, sign and verify, and check every screen
summary against hand-built requests.

## Report a problem

See [SECURITY.md](../../SECURITY.md). Please report security problems privately.

## License

Source-available under the [Business Source License 1.1](LICENSE): anyone may read, review, build and test it, including to
verify MAXXING's releases, but not run it in production as their own wallet or service. Each version becomes GPL-3.0-or-later four
years after its release. "MAXXING" and its logo are not licensed; see [TRADEMARKS.md](../../TRADEMARKS.md).
