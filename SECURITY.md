# Security

The MAXXING wallet holds people's money, so we take every report seriously.

## Report a vulnerability

Email **support@maxxing.ad** with **"Security"** in the subject. Please include:

- what you found and where (package, version, file or URL),
- the steps to reproduce it,
- what an attacker could do with it.

Please don't open a public issue or share details publicly until we have fixed it. We'll confirm we received your report within
3 working days and keep you updated until it's resolved. With your permission, we'll credit you in the changelog.

## Supported versions

Security fixes go into the newest `@maxxing/wallet-sdk` release. Earlier versions stay online but don't receive fixes; update to
the newest version.

## In scope

- `@maxxing/wallet-sdk` (this repository)
- `@maxxing/wallet-core` (this repository): the recovery phrase, the PIN and passkey vault, signing, and the request screens' checks
- The wallet window at `wallet.maxxing.ad` that the SDK opens (`apps/wallet` in this repository)
- Anything that contradicts [docs/SELF-CUSTODY.md](docs/SELF-CUSTODY.md): a way for a recovery phrase, a key or the PIN to leave
  the device, or for MAXXING to sign for a user
- The public APIs the SDK calls at `api.maxxing.ad`

Please don't test against other people's wallets or accounts, run denial-of-service tests, or use social engineering.
