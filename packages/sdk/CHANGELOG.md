# Changelog

`@maxxing/wallet-sdk` follows semantic versioning. Before 1.0, a minor version (0.x.0) may change an API; a patch (0.x.y) never
does.

Every change ships as a new version. The script-tag build at `https://developers.maxxing.ad/sdk/<version>/` never changes once
published, and stays online. `https://developers.maxxing.ad/sdk/v0/` always serves the newest 0.x build, and may include new
networks before they reach a numbered release; each such update is then released as a patch, so pinned versions can take it.

Versioning policy: https://developers.maxxing.ad/versioning

## 0.2.2 (2026-11-25)

### Open source

- The source is public at https://github.com/maxxingdotad/maxxing-wallet, and this is the first release built and published from
  it, with npm provenance: the npm page links the exact commit and workflow run. `npm audit signatures` checks it.
- The SDK builds on its own: its network list is generated from MAXXING's chain registry into `src/chains.generated.ts` (public
  data only). The networks offered are unchanged.
- `package.json` names the repository.

## 0.2.1 (2026-11-25)

### Docs

- README rewritten for partners: a quick start, contents, requirements (browsers, runtimes, React, TypeScript), the React
  provider first, the Data API before the features that use it, error-code tables, a typed wagmi example, and security,
  versioning, support and license sections. Earnings rates now point to the dashboard's live numbers.
- No code changes.

## 0.2.0 (2026-11-24)

### Breaking

- `verifySignIn` requires `nonce` (the nonce you stored with the message). Without it a signed message could be accepted again.
  Calls without it throw `SignInError` `INVALID_REQUEST`.
- `verifyIdentityToken` accepts only tokens issued by `https://api.maxxing.ad` (pass `issuer` to check another). Tokens naming a
  `http://localhost` issuer are refused.

### Changed

- `verifyIdentityToken` fetches MAXXING's keys again for an unknown key at most once a minute per JWKS address.
- `browserRpcOrigins()` (new): the public RPC origins the SDK reads chains from, for your Content-Security-Policy `connect-src`.
- Earnings: the trade widget's app becomes the inviter of a trader who has none once that trader's first buy through it lands
  (off chain, live apps only). Docs and types say so.
- Published `.d.ts` files no longer reference the MAXXING chain registry.
- `package.json`: `engines`, `homepage`, `bugs`, `keywords`, `./browser` types and `./package.json` export for publishing.

## 0.1.0 (2026-11-21)

- First release: EIP-1193 provider (EIP-6963), Solana Wallet Standard wallet, wallet window transport, connect button and
  `<maxxing-connect>`, social sign-in with identity tokens, React provider and hooks, the Data API client with the live stream,
  the trade widget, and server helpers (`createSignIn`, `verifySignIn`, `verifyIdentityToken`, `verifyWebhook`).
