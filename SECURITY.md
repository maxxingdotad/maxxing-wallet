# Security policy

The MAXXING wallet protects people's funds. We treat every report seriously and are grateful to the people who send them.

## Report a vulnerability

Email **support@maxxing.ad** with **"Security"** in the subject line. Please include:

- what you found and where (package and version, file, or URL);
- steps to reproduce it;
- what an attacker could do with it.

Please don't open a public issue or share the details anywhere until a fix is released.

**What happens next**

- We confirm that we received your report within 3 working days.
- We keep you informed until it is resolved.
- With your permission, we credit you in the changelog.

## Scope

In scope:

- `@maxxing/wallet-sdk` ([`packages/sdk`](packages/sdk));
- `@maxxing/wallet-core` ([`packages/core`](packages/core)): the recovery phrase, the PIN and passkey vault, signing, and the
  checks behind the approval screen;
- the wallet window at `wallet.maxxing.ad` ([`apps/wallet`](apps/wallet));
- anything that contradicts [Self-custody](docs/SELF-CUSTODY.md), such as a way for a recovery phrase, key or PIN to leave the
  device, or for MAXXING or a website to get a signature the user didn't approve;
- the public APIs the SDK calls at `api.maxxing.ad`.

Out of scope:

- the limits that [Self-custody](docs/SELF-CUSTODY.md) already states, such as offline PIN guessing against a copied browser
  profile, or one-tap trading behaving as described once a user turns it on;
- issues that need a device or browser that is already compromised;
- missing best-practice headers with no demonstrated impact.

## Testing rules

- Test only with wallets and accounts you own.
- Don't run denial-of-service tests, spam, or social engineering against MAXXING staff or users.
- Don't access, change or keep other people's data. If you reach any by accident, stop and tell us.

## Supported versions

Security fixes go into the newest release of `@maxxing/wallet-sdk`. Earlier versions stay available but don't receive fixes, so
please update. The wallet window at `wallet.maxxing.ad` always runs the current version.
