# MAXXING Wallet

The open-source side of the MAXXING wallet: the code partners and users run, published so anyone can read it and check that the
packages on npm are built from it.

| Package | What it is | npm |
| --- | --- | --- |
| [`packages/sdk`](packages/sdk) | `@maxxing/wallet-sdk`: let people use their MAXXING wallet on your site (EIP-1193 / EIP-6963 provider, Solana Wallet Standard wallet, sign-in, Data API, trade widget, server helpers) | [@maxxing/wallet-sdk](https://www.npmjs.com/package/@maxxing/wallet-sdk) |

Start with the [SDK guide](packages/sdk/README.md), or the docs at [developers.maxxing.ad/docs](https://developers.maxxing.ad/docs).

## Verify what you install

Every npm release is built and published by this repository's [release workflow](.github/workflows/release.yml), with
[npm provenance](https://docs.npmjs.com/generating-provenance-statements). On the package's npm page, the provenance panel links
the exact commit and workflow run that built it. From a terminal:

```bash
npm audit signatures
```

## Build it yourself

```bash
pnpm install --frozen-lockfile
pnpm --filter @maxxing/wallet-sdk build
pnpm --filter @maxxing/wallet-sdk test
```

Requires Node 22 and pnpm 10.

## How this repository is updated

MAXXING develops the wallet in its main repository and copies each SDK release here, file for file, before it is published.
The network list in `packages/sdk/src/chains.generated.ts` is generated from MAXXING's chain registry and holds only public data.

Issues are welcome: bugs, questions and ideas. Please report security problems privately; see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
