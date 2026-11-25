# Contributing

Thank you for taking the time to look at the MAXXING wallet. Reviews, bug reports and questions all make it better.

## Report a security problem privately

If you think you've found a vulnerability, **don't open an issue**. Email support@maxxing.ad as described in
[SECURITY.md](SECURITY.md).

## Issues are welcome

[Open an issue](https://github.com/maxxingdotad/maxxing-wallet/issues/new/choose) for:

- a bug in the SDK or the wallet window, with steps to reproduce it;
- a place where the code and the docs disagree, especially [Self-custody](docs/SELF-CUSTODY.md);
- a question about how something works;
- a feature request for the SDK.

Please search existing issues first, and include versions (SDK version, browser, operating system) where they matter.

## Pull requests

This repository is a copy. MAXXING develops the wallet in a private repository and copies these folders here unchanged, so a pull
request can't be merged here; the next copy would overwrite it.

If you have a fix, open an issue that describes it, or link your branch from the issue. We'll make the change in the main
repository, and it will appear here with the next update. We credit contributors in the changelog when they agree.

## Building and testing

You need Node 22 and pnpm 10.

```bash
pnpm install --frozen-lockfile
pnpm --filter @maxxing/wallet-sdk test
pnpm --filter @maxxing/wallet-core test
pnpm --filter @maxxing/wallet-frame test
```

## Conduct

Everyone taking part is expected to follow the [code of conduct](CODE_OF_CONDUCT.md).
