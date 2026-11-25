# MAXXING Wallet

This repository holds the source of the MAXXING wallet: the SDK that apps install, the code that creates and protects your keys,
and the wallet window at `wallet.maxxing.ad`. It is public so that anyone can read it, build it and check that what runs is built
from it.

The MAXXING wallet is self-custodial. Your recovery phrase and private keys are created on your device, stay on your device and
are used there to sign. MAXXING has no copy of them and cannot restore them.

| Folder | Package | What it is | License |
| --- | --- | --- | --- |
| [`packages/sdk`](packages/sdk) | `@maxxing/wallet-sdk` | Lets people use their MAXXING wallet in your app: an EIP-1193 provider (announced with EIP-6963), a Solana Wallet Standard wallet, sign-in, the Data API client, the trade widget and server helpers. Published to [npm](https://www.npmjs.com/package/@maxxing/wallet-sdk) with provenance. | MIT |
| [`packages/core`](packages/core) | `@maxxing/wallet-core` | The key code: the recovery phrase, the PIN and passkey vault, EVM and Solana signing, and what the approval screen shows. Not published; the wallet window uses it. | BUSL-1.1 |
| [`apps/wallet`](apps/wallet) | `@maxxing/wallet-frame` | The wallet window at `wallet.maxxing.ad`: the pages that hold your wallet, ask for your PIN and show each request before you sign. | BUSL-1.1 |

## Why you can trust it

- **Keys never leave your device.** The phrase is encrypted in your browser with AES-256-GCM. It opens with your PIN, an optional
  passkey, or a non-extractable device key while you stay signed in. No secret is ever sent; every request the wallet makes is listed in
  [Self-custody](docs/SELF-CUSTODY.md#what-leaves-your-device).
- **You approve every signature.** By default, every request from every site opens the wallet's approval screen, and what is
  signed is exactly what the screen showed.
- **Tests enforce it.** The no-leak tests run the wallet's full lifecycle with the network and console trapped. They fail if a
  phrase, key or PIN shows up in a request, in the console or in readable form in storage.
- **What still depends on MAXXING is written down.** The trust points are listed in
  [Self-custody](docs/SELF-CUSTODY.md#what-still-depends-on-maxxing), with how to check each one.

## Use the SDK

```bash
npm install @maxxing/wallet-sdk
```

```js
import { createMaxxingWallet } from "@maxxing/wallet-sdk";

const wallet = createMaxxingWallet({ appId: "app_your_app_id", chains: [8453] });
const { evm, solana } = await wallet.connect(); // call from a click
```

The [SDK guide](packages/sdk/README.md) covers wagmi, viem, React, Solana, sign-in and the server helpers. Register an app and
read the full docs at [developers.maxxing.ad](https://developers.maxxing.ad/docs).

## Verify what you run

**The SDK on npm.** Every release is built and published by this repository's
[release workflow](.github/workflows/release.yml) with [npm provenance](https://docs.npmjs.com/generating-provenance-statements).
The package page on npm links the commit and the workflow run that built it. To check an installed copy:

```bash
npm audit signatures
```

**The wallet window.** `apps/wallet` is the source of `wallet.maxxing.ad`. Its deployments are moving to build directly from this
repository's `main` branch, so that each deployment matches a public commit. CI prints a SHA-256 hash for every file it builds,
and [Self-custody](docs/SELF-CUSTODY.md#how-to-check-it-yourself) explains how to rebuild and compare.

## Build and test

You need Node 22 and pnpm 10.

```bash
pnpm install --frozen-lockfile
pnpm --filter @maxxing/wallet-sdk test
pnpm --filter @maxxing/wallet-sdk build
pnpm --filter @maxxing/wallet-core test
pnpm --filter @maxxing/wallet-frame test
pnpm --filter @maxxing/wallet-frame build
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md): the parts, how a request flows, and where each check happens.
- [Self-custody](docs/SELF-CUSTODY.md): how keys are made and kept, what leaves your device, the trust points, and how to verify.
- [SDK guide](packages/sdk/README.md) and [changelog](packages/sdk/CHANGELOG.md).
- [Wallet core](packages/core/README.md): a map of the key code, file by file.

## How this repository is maintained

MAXXING develops the wallet in a private repository and copies these three folders here unchanged: the SDK before each release,
the core and the wallet window whenever they change. This is the same code `wallet.maxxing.ad` runs, not a fork. The network
lists (`packages/sdk/src/chains.generated.ts` and `packages/core/src/chain-data.generated.ts`) are generated from MAXXING's chain
registry and contain public data only.

Because of this, we can't merge pull requests here. Issues are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

Please report vulnerabilities privately to **support@maxxing.ad**, not in a public issue. [SECURITY.md](SECURITY.md) has the
details and the scope.

## Licensing

- **`packages/sdk` is MIT** ([LICENSE](packages/sdk/LICENSE)). Use it in any app, commercial or not. It does not import the
  wallet code below, so the npm package is MIT throughout.
- **`packages/core` and `apps/wallet` are source-available under the Business Source License 1.1** (see the `LICENSE` file in
  each folder). Anyone may read, review, build and test them, including to verify MAXXING's releases. Running them in production
  as your own wallet or service is not permitted. Each version becomes available under GPL-3.0-or-later four years after its first
  public release.
- **The MAXXING name and logo are not licensed** by any of these. See [TRADEMARKS.md](TRADEMARKS.md).

The [LICENSE](LICENSE) file at the root explains this split.
