# @maxxing/wallet-core

The key code of the MAXXING wallet. It creates the recovery phrase and keys, keeps them encrypted on the device, opens them with
the PIN or a passkey, signs requests, and builds what the approval screen shows before anything is signed.

The wallet window at `wallet.maxxing.ad` runs this package. It is developed in MAXXING's main repository and copied here
unchanged. It is not published to npm: read it, test it and build it from this repository. How it adds up to a self-custodial
wallet, and how to check that, is in [Self-custody](../../docs/SELF-CUSTODY.md).

This package makes no network calls and never writes to the console. A test enforces both.

## Files

| File | What it does |
| --- | --- |
| [`src/derive.ts`](src/derive.ts) | Creates and checks the recovery phrase (BIP-39, 12 words) and derives the EVM key (`m/44'/60'/0'/0/0`, BIP-32 secp256k1) and the Solana key (`m/44'/501'/0'/0'`, SLIP-0010 ed25519). Seeds and intermediate keys are wiped after use. |
| [`src/vault.ts`](src/vault.ts) | The wallets on a device. Each recovery phrase is encrypted with its own random 256-bit data key (AES-256-GCM, bound to the wallet's id and addresses). The data key is wrapped by the 6-digit PIN (PBKDF2-SHA-256, 600,000 iterations), optionally by a passkey (WebAuthn PRF output through HKDF), and, while the user stays signed in, by a device key the browser won't reveal. After five wrong PINs the user waits 30 seconds, then twice as long after each further wrong PIN, up to an hour; they are never locked out. Keys are held in memory only while the wallet is open, and are overwritten with zeros on sign-out, on switching wallets and when the page closes. |
| [`src/device-session.ts`](src/device-session.ts) | Keeps a wallet open on this device until sign-out, by wrapping the data key with a non-extractable AES key stored in IndexedDB. Page code can use that key but never read it. |
| [`src/signing.ts`](src/signing.ts) | Signs EVM messages, typed data, transactions and EIP-7702 authorizations, and Solana bytes. Only signatures are returned. EIP-7702 delegation is allowed to one fixed contract address only. |
| [`src/solana-tx.ts`](src/solana-tx.ts) | Reads a Solana transaction (legacy or v0) far enough to show what it does, signs it in the wallet's own signer slot, and refuses a transaction disguised as a message. |
| [`src/review.ts`](src/review.ts) | Builds the approval screen: messages as text or bytes; typed data field by field, with a warning on permits and orders; transactions with network, amount and the highest possible fee; token approvals and transfers in words, with a warning on unlimited approvals; and Solana token instructions. Transactions are checked field by field so that what is shown is what is signed. Anything the screen would show differently is refused. |
| [`src/sign-in.ts`](src/sign-in.ts) | Checks a sign-in message (EIP-4361) against the site asking, the account signing and its time window. |
| [`src/simulation.ts`](src/simulation.ts) | Turns a simulated transaction into what leaves and what arrives in the wallet, and checks the balance against what a transaction can spend. |
| [`src/approvals.ts`](src/approvals.ts) | Records which apps each wallet has connected to, per website, and whether the user has turned on one-tap trading for maxxing.ad (off by default). |
| [`src/app-links.ts`](src/app-links.ts) | Checks the MAXXING website, support and status links that the wallet shows, so only `https://` pages and email addresses are used. |
| [`src/chains.ts`](src/chains.ts), [`src/chain-data.generated.ts`](src/chain-data.generated.ts) | The networks and tokens the approval screen names. Generated from MAXXING's chain registry and public data only. Production builds turn test networks off. |

## Tests

```bash
pnpm install --frozen-lockfile
pnpm --filter @maxxing/wallet-core typecheck
pnpm --filter @maxxing/wallet-core test
```

The tests create, open, lock, restore and remove wallets in memory, try wrong PINs, sign and verify, and check every approval
screen summary against hand-built requests. [`tests/no-leak.test.ts`](tests/no-leak.test.ts) runs the whole lifecycle with the
network and console trapped and fails if a secret could leave the device.

## Security

Please report vulnerabilities privately; see [SECURITY.md](../../SECURITY.md).

## License

Source-available under the [Business Source License 1.1](LICENSE). Anyone may read, review, build and test it, including to
verify MAXXING's releases. Running it in production as your own wallet or service is not permitted. Each version becomes available
under GPL-3.0-or-later four years after its first public release. The MAXXING name and logo are not licensed; see
[TRADEMARKS.md](../../TRADEMARKS.md).
