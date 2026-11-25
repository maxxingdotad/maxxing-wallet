# MAXXING Wallet

The MAXXING wallet in the open: the SDK partners install, the wallet's key-safety code, and the wallet window at
`wallet.maxxing.ad`, published so anyone can read it, build it and check that what runs is built from it.

The MAXXING wallet is self-custodial: your recovery phrase and keys are created on your device and stay there. MAXXING never has
your keys. [docs/SELF-CUSTODY.md](docs/SELF-CUSTODY.md) explains how, what still depends on MAXXING, and how to check all of it.

| Folder | What it is | License | Published |
| --- | --- | --- | --- |
| [`packages/sdk`](packages/sdk) | `@maxxing/wallet-sdk`: let people use their MAXXING wallet on your site (EIP-1193 / EIP-6963 provider, Solana Wallet Standard wallet, sign-in, Data API, trade widget, server helpers) | MIT | [npm](https://www.npmjs.com/package/@maxxing/wallet-sdk), with provenance |
| [`packages/core`](packages/core) | `@maxxing/wallet-core`: the wallet's key-safety code. Recovery phrase and keys, the PIN and passkey vault, EVM and Solana signing, and what you are shown before you sign | BUSL-1.1 | not published; used by the wallet window |
| [`apps/wallet`](apps/wallet) | The wallet window at `wallet.maxxing.ad`: the pages that hold your wallet, ask for your PIN and show every request before you sign | BUSL-1.1 | runs at `wallet.maxxing.ad` |

Start with the [SDK guide](packages/sdk/README.md), or the docs at [developers.maxxing.ad/docs](https://developers.maxxing.ad/docs).
To see how your keys are kept, read [`packages/core`](packages/core/README.md).

## Verify what you install and use

Every npm release of the SDK is built and published by this repository's [release workflow](.github/workflows/release.yml), with
[npm provenance](https://docs.npmjs.com/generating-provenance-statements). On the package's npm page, the provenance panel links
the exact commit and workflow run that built it. From a terminal:

```bash
npm audit signatures
```

`apps/wallet` is the source `wallet.maxxing.ad` is built from. Its deployments are moving to build directly from this repository's
`main` branch, so that each one corresponds to a public commit. How to rebuild it and compare is in
[docs/SELF-CUSTODY.md](docs/SELF-CUSTODY.md#how-to-check-it-yourself).

## Build it yourself

```bash
pnpm install --frozen-lockfile
pnpm --filter @maxxing/wallet-sdk build
pnpm --filter @maxxing/wallet-sdk test
pnpm --filter @maxxing/wallet-core test
pnpm --filter @maxxing/wallet-frame test
pnpm --filter @maxxing/wallet-frame build
```

Requires Node 22 and pnpm 10.

## How this repository is updated

MAXXING develops the wallet in its main repository and copies these folders here, file for file: each SDK release before it is
published, and the wallet core and window whenever they change. There is one copy of each, not a fork: `wallet.maxxing.ad` runs
this code. The network lists in `packages/sdk/src/chains.generated.ts` and `packages/core/src/chain-data.generated.ts` are generated
from MAXXING's chain registry and hold only public data.

Issues are welcome: bugs, questions and ideas. Please report security problems privately; see [SECURITY.md](SECURITY.md).

## Licenses

- **`packages/sdk` is MIT** ([LICENSE](LICENSE)). Use it in any app, commercial or not. It never imports the wallet code below, so
  the npm package is MIT throughout.
- **`packages/core` and `apps/wallet` are source-available under the Business Source License 1.1** (their own `LICENSE` files).
  Anyone may read, review, build and test them, including to verify MAXXING's releases; running them in production as your own
  wallet or service is not allowed. Each version becomes GPL-3.0-or-later four years after its release.
- **"MAXXING" and the MAXXING logo are not licensed** under any of these. See [TRADEMARKS.md](TRADEMARKS.md).
