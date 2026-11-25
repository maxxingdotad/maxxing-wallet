import "fake-indexeddb/auto";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { verifyMessage, verifyTypedData, parseTransaction } from "viem";

// A browser-like window for the wallet: storage, events and cross-tab locks.
const data = new Map<string, string>();
const localStorage = {
  getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, String(v)),
  removeItem: (k: string) => void data.delete(k), clear: () => data.clear(),
  key: (i: number) => [...data.keys()][i] ?? null, get length() { return data.size; },
};
Object.assign(globalThis, { window: Object.assign(new EventTarget(), { localStorage }), localStorage });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: { request: async (_: string, action: () => unknown) => action() } } });

const vault = await import("@maxxing/wallet-core/vault");
const signing = await import("@maxxing/wallet-core/signing");
const { oneTapEnabled, setOneTap, forgetWallet } = await import("@maxxing/wallet-core/approvals");
const { approvalView, signWithConsent, USER_REJECTED, SIGNING_METHODS } = await import("../src/consent");

const ORIGIN = "https://maxxing.ad", PIN = "246810";
const SIGNERS: Record<string, (p: any) => unknown> = {
  "evm.signMessage": p => signing.evmSignMessage(p), "evm.signTypedData": p => signing.evmSignTypedData(p),
  "evm.signTransaction": p => signing.evmSignTransaction(p), "evm.signAuthorization": p => signing.evmSignAuthorization(p),
  "solana.signBytes": p => signing.solanaSignBytes(p),
};
const TX = { chainId: 8453, to: "0x2222222222222222222222222222222222222222" as const, value: 10n ** 15n, gas: 21000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1n, nonce: 0, type: "eip1559" as const };
const TYPED = { domain: { name: "Acme", chainId: 8453 }, types: { Login: [{ name: "nonce", type: "string" }] }, primaryType: "Login", message: { nonce: "x" } };

/** A screen that records what it was shown and answers as told. */
function screen(answer: boolean) {
  const shown: { title: string; site: string }[] = [];
  return { shown, ask: async (view: { title: string; site: string }) => { shown.push(view); return answer; } };
}
const run = (method: (typeof SIGNING_METHODS)[number], params: unknown, ask: (v: any) => Promise<boolean>) =>
  signWithConsent(method, params, ORIGIN, ask, p => SIGNERS[method]!(p));

test("by default every signature from maxxing.ad is shown first, and nothing is signed unless approved", async () => {
  const wallet = await vault.createPlatformWallet(PIN);
  assert.equal(oneTapEnabled(vault.activePlatformWalletId()), false, "one-tap is off for a new wallet");

  for (const [method, params] of [["evm.signMessage", { message: "hello" }], ["evm.signTypedData", TYPED], ["evm.signTransaction", { transaction: TX }],
    ["evm.signAuthorization", { address: signing.ALLOWED_DELEGATE, chainId: 8453, nonce: 0 }], ["solana.signBytes", { bytes: new TextEncoder().encode("hello") }]] as const) {
    const declined = screen(false);
    await assert.rejects(run(method, params, declined.ask), (e: Error & { code?: number }) => e.message === USER_REJECTED && e.code === 4001, `${method}: declined`);
    assert.equal(declined.shown.length, 1, `${method}: shown before anything is signed`);
    assert.equal(declined.shown[0]!.site, "maxxing.ad");
    const approved = screen(true);
    const signature = await run(method, params, approved.ask);
    assert.equal(approved.shown.length, 1);
    assert.ok(signature, `${method}: signed after approval`);
  }

  // What was approved is what was signed.
  const message = await run("evm.signMessage", { message: "hello" }, screen(true).ask) as `0x${string}`;
  assert.ok(await verifyMessage({ address: wallet.evm, message: "hello", signature: message }));
  const typed = await run("evm.signTypedData", TYPED, screen(true).ask) as `0x${string}`;
  assert.ok(await verifyTypedData({ address: wallet.evm, ...(TYPED as any), signature: typed }));
  const raw = await run("evm.signTransaction", { transaction: TX }, screen(true).ask) as `0x${string}`;
  const parsed = parseTransaction(raw);
  assert.equal(parsed.to, TX.to); assert.equal(parsed.value, TX.value); assert.equal(parsed.chainId, TX.chainId);
});

test("a request that can't be shown exactly is refused, and a locked wallet asks nothing", async () => {
  const asked = screen(true);
  await assert.rejects(run("evm.signTransaction", { transaction: { ...TX, value: "0x1" } }, asked.ask), /INVALID_TRANSACTION/);
  await assert.rejects(run("evm.signTransaction", { transaction: { ...TX, authorizationList: [] } }, asked.ask), /INVALID_TRANSACTION/);
  await assert.rejects(run("evm.signAuthorization", { address: "0x1111111111111111111111111111111111111111", chainId: 1, nonce: 0 }, asked.ask), /RELAY_AUTHORIZATION_DELEGATE/);
  assert.equal(asked.shown.length, 0, "nothing unshowable reaches the screen");
  await vault.signOutPlatformWallet();
  await assert.rejects(run("evm.signMessage", { message: "hi" }, asked.ask), /WALLET_LOCKED/);
  assert.equal(asked.shown.length, 0);
  await vault.unlockPlatformWallet(PIN);
});

test("one-tap trading, once the user turns it on, signs maxxing.ad's requests without a prompt; off again, it asks again", async () => {
  const id = vault.activePlatformWalletId()!;
  setOneTap(id, true);
  const silent = screen(false);
  assert.ok(await run("evm.signMessage", { message: "trade" }, silent.ask));
  assert.equal(silent.shown.length, 0, "no prompt with one-tap on");
  setOneTap(id, false);
  await assert.rejects(run("evm.signMessage", { message: "trade" }, silent.ask), (e: Error) => e.message === USER_REJECTED);
  assert.equal(silent.shown.length, 1, "prompts again once turned off");

  // One-tap is per wallet: another wallet still asks, and removing a wallet drops its choice.
  setOneTap(id, true);
  await vault.createPlatformWallet(PIN, "Second");
  const second = screen(false);
  await assert.rejects(run("evm.signMessage", { message: "x" }, second.ask));
  assert.equal(second.shown.length, 1);
  forgetWallet(id);
  assert.equal(oneTapEnabled(id), false);
  // A damaged or forged record counts as off.
  localStorage.setItem("maxxing.walletOneTap.v1", JSON.stringify({ version: 1, wallets: { [vault.activePlatformWalletId()!]: { on: "yes", since: 1 } } }));
  assert.equal(oneTapEnabled(vault.activePlatformWalletId()), false);
});

test("approval screens say what each request is", () => {
  const wallet = { evm: "0x1111111111111111111111111111111111111111", solana: "11111111111111111111111111111111" };
  const signIn = ["maxxing.ad wants you to sign in with your Ethereum account:", wallet.evm, "", "Sign in to MAXXING.", "", "URI: https://maxxing.ad",
    "Version: 1", "Chain ID: 8453", "Nonce: abcdef123456", `Issued At: ${new Date().toISOString()}`].join("\n");
  assert.equal(approvalView("evm.signMessage", { message: signIn }, ORIGIN, wallet).view.title, "Sign in to maxxing.ad");
  const elsewhere = approvalView("evm.signMessage", { message: signIn.replace(/maxxing\.ad/g, "evil.example") }, ORIGIN, wallet).view;
  assert.equal(elsewhere.title, "Sign a message");
  assert.match(elsewhere.warnings[0]!, /different site/);
  assert.equal(approvalView("evm.signTransaction", { transaction: TX }, ORIGIN, wallet).view.title, "Send 0.001 ETH");
  assert.equal(approvalView("evm.signAuthorization", { address: signing.ALLOWED_DELEGATE, chainId: 8453, nonce: 0 }, ORIGIN, wallet).view.title, "Turn on gasless trading");
  const permit = approvalView("evm.signTypedData", { ...TYPED, primaryType: "Permit", types: { Permit: [{ name: "spender", type: "address" }] }, message: { spender: wallet.evm } }, ORIGIN, wallet).view;
  assert.equal(permit.title, "Approve a spending permission");
  assert.ok(permit.warnings.length);
});

test("the frame signs only through consent, and one-tap can only be turned on from the wallet's own screen with the PIN", () => {
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.match(main, /isSigningMethod\(request\.method\) \? withConsent\(/, "every signing method goes through consent");
  assert.doesNotMatch(main, /setOneTap/, "no app request can change one-tap");
  const screens = readFileSync(new URL("../src/ui/screens.tsx", import.meta.url), "utf8");
  assert.match(screens, /checkPlatformPin\(pin\); setOneTap\(active\.id, true\)/, "turning it on takes the PIN");
});
