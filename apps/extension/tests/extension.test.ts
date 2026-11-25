import "./env";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import bs58 from "bs58";
import nacl from "tweetnacl";

const { encode, decode } = await import("../src/lib/codec");
const { checkSite, parseList, unicodeHost } = await import("../src/lib/phishing");
const { siteName } = await import("../src/lib/site");
const { readFileSync } = await import("node:fs");
const { parseUnits, solTransferTransaction, checkRecipient, validRecipient } = await import("../src/lib/send");
const { parseSolanaTransaction, isSolanaTransactionMessage } = await import("@maxxing/wallet-core/solana-tx");
const wallet = await import("../src/lib/wallet");
const store = await import("../src/lib/store");

test("requests survive the JSON hops: bigints and bytes come back exactly", () => {
  const value = { transaction: { chainId: 8453, value: 10n ** 18n, gas: 21000n, data: "0x" }, bytes: new Uint8Array([0, 1, 254, 255]), list: [1n, "a"] };
  const back = decode(JSON.parse(JSON.stringify(encode(value)))) as typeof value;
  assert.equal(back.transaction.value, 10n ** 18n);
  assert.deepEqual([...back.bytes], [0, 1, 254, 255]);
  assert.equal(back.list[0], 1n);
  // A look-alike tag with extra keys stays a plain object.
  assert.deepEqual(decode({ $bigint: "1", other: 2 }), { $bigint: "1", other: 2 });
});

test("phishing: MAXXING's own sites pass, look-alikes and listed hosts are stopped", () => {
  for (const ok of ["https://maxxing.ad", "https://wallet.maxxing.ad", "https://any.sub.maxxing.ad", "https://app.example-dex.io", "http://localhost:3000", "https://maximizing.io", "https://mixing.app", "https://boxing.club", "https://taxing.gov"])
    assert.equal(checkSite(ok).kind, "ok", ok);
  for (const bad of ["https://maxxing-airdrop.claims", "https://m4xxing.io", "https://maxxlng.com", "https://claim-maxxing.net", "https://maxing.ad", "https://rnaxxing.ad",
    "https://maxxing.ad.evil.io", "https://maxxlng.ad", "https://mаxxing.ad" /* Cyrillic а */, "https://maxxіng.io" /* Cyrillic і */, "https://maxxinq.io", "https://maxxing.com", "https://m-a-x-x-i-n-g.net"])
    assert.equal(checkSite(bad).kind, "phishing", bad);
  // Punycode is read as the letters a person sees.
  assert.equal(new URL("https://mаxxing.ad").hostname.startsWith("xn--"), true);
  assert.equal(unicodeHost(new URL("https://mаxxing.ad").hostname), "mаxxing.ad");
  assert.equal(checkSite("https://evil.example", new Set(["evil.example"])).kind, "phishing");
  assert.equal(checkSite("https://a.b.evil.example", new Set(["evil.example"])).kind, "phishing", "subdomains of a listed host too");
  // The shipped blocklist reads as hosts, and never lists MAXXING itself.
  const shipped = parseList(readFileSync(new URL("../public/phishing/hosts.txt", import.meta.url), "utf8"));
  assert.ok(shipped.size > 1000, "the shipped list is the real one");
  assert.ok(![...shipped].some(h => h === "maxxing.ad" || h.endsWith(".maxxing.ad")));
  assert.deepEqual([...parseList(JSON.stringify({ deny: ["Evil.Example.", "*.wild.example", "nodot"] }))], ["evil.example", "wild.example"]);
});

test("the approval window shows who a site is: the registrable domain in full, the full address under it", () => {
  assert.deepEqual(pick(siteName("https://app.uniswap-claim.example.co.uk")), { domain: "example.co.uk", host: "app.uniswap-claim.example.co.uk", insecure: false });
  assert.equal(siteName("https://drainer.vercel.app").domain, "drainer.vercel.app", "on shared hosting, the customer's own name");
  assert.equal(siteName("https://a.b.c.very-long-name-that-would-not-fit-on-one-line.example").domain, "very-long-name-that-would-not-fit-on-one-line.example");
  assert.equal(siteName("http://shop.example").insecure, true);
  assert.equal(siteName("http://localhost:5173").insecure, false);
  assert.equal(siteName("https://mаxxing.ad").unicode, "mаxxing.ad");
  // The page's CSS never cuts the name: no ellipsis anywhere in the approval window.
  assert.ok(!readFileSync(new URL("../src/approve.tsx", import.meta.url), "utf8").includes("ellipsis"));
});
const pick = (s: ReturnType<typeof siteName>) => ({ domain: s.domain, host: s.host, insecure: s.insecure });

test("the pages may connect only to the registry's RPC origins and the named services", async () => {
  const { connectOrigins, extensionCsp, SERVICES } = await import("../src/lib/csp");
  const { API_URL } = await import("../src/lib/balances");
  const { RELAY_API } = await import("../src/lib/relay");
  const { BLOCKLIST_SOURCE } = await import("../src/lib/blocklist");
  assert.deepEqual(SERVICES, [API_URL, RELAY_API, new URL(BLOCKLIST_SOURCE).origin]);
  const origins = connectOrigins();
  assert.ok(origins.every(o => /^https:\/\/[^/*]+$/.test(o)), "exact https origins, no wildcards");
  assert.ok(origins.length > 5);
  const csp = extensionCsp();
  assert.match(csp, /img-src 'self' data:;/);
  assert.ok(!/connect-src[^;]*\bhttps:(\s|;|$)/.test(csp), "no blanket https:");
  assert.ok(!/wss:/.test(csp));
});

test("amounts are exact, and odd input is refused", () => {
  assert.equal(parseUnits("1.5", 6), 1_500_000n);
  assert.equal(parseUnits("1,000", 18), 1000n * 10n ** 18n);
  assert.equal(parseUnits(".25", 9), 250_000_000n);
  assert.throws(() => parseUnits("1.0000001", 6), /decimals/);
  assert.throws(() => parseUnits("abc", 6), /amount/);
  assert.equal(validRecipient("EVM", "0x1111111111111111111111111111111111111111"), true);
  assert.equal(validRecipient("EVM", "0x111"), false);
  assert.equal(validRecipient("SOLANA", bs58.encode(new Uint8Array(32).fill(3))), true);
  assert.equal(validRecipient("SOLANA", "0x1111111111111111111111111111111111111111"), false);
});

test("a SOL transfer is built so the wallet core reads it back exactly: one transfer, the right amount, the user as fee payer", () => {
  const from = bs58.encode(nacl.sign.keyPair().publicKey), to = bs58.encode(nacl.sign.keyPair().publicKey);
  const tx = solTransferTransaction(from, to, 1_250_000_000n, bs58.encode(new Uint8Array(32).fill(9)));
  const parsed = parseSolanaTransaction(tx);
  assert.equal(parsed.feePayer, from);
  assert.deepEqual(parsed.transfers, [{ from, to, lamports: 1_250_000_000n }]);
  assert.equal(parsed.otherInstructions, 0);
  assert.equal(isSolanaTransactionMessage(tx.subarray(parsed.messageOffset)), true);
});

test("address poisoning: a new address that starts and ends like one you paid is flagged", async () => {
  await store.kept.set("recipients", ["0xabcdef1111111111111111111111111111119999"]);
  assert.deepEqual(await checkRecipient("0xabcdef1111111111111111111111111111119999"), { firstTime: false, lookalike: null });
  assert.equal((await checkRecipient("0xabcdef2222222222222222222222222222229999")).lookalike, "0xabcdef1111111111111111111111111111119999");
  assert.deepEqual(await checkRecipient("0x9999999999999999999999999999999999999999"), { firstTime: true, lookalike: null });
});

test("site requests are reviewed by the core and signed as shown; a Solana 'message' that is a transaction is refused", async () => {
  await wallet.create("246810");
  const open = wallet.snapshot().public!;
  const { view, signed } = wallet.review("evm.signMessage", { address: open.evm, message: "hello" }, "https://app.example");
  assert.equal(view.title, "Sign a message");
  assert.equal(view.site, "app.example");
  assert.match(String(await wallet.sign("evm.signMessage", { address: open.evm, message: "hello" }, signed)), /^0x[0-9a-f]{130}$/);
  assert.throws(() => wallet.review("evm.signMessage", { address: "0x1111111111111111111111111111111111111111", message: "x" }, "https://app.example"), /WALLET_CHANGED/);
  const tx = solTransferTransaction(open.solana, bs58.encode(new Uint8Array(32).fill(4)), 1n, bs58.encode(new Uint8Array(32).fill(9)));
  assert.throws(() => wallet.review("solana.signMessage", { address: open.solana, bytes: tx.subarray(parseSolanaTransaction(tx).messageOffset) }, "https://app.example"), /SOLANA_MESSAGE_IS_TRANSACTION/);
  const solTx = wallet.review("solana.signTransaction", { address: open.solana, bytes: tx }, "https://app.example");
  assert.equal(solTx.view.title, "Confirm a Solana transaction");
  const signedTx = await wallet.sign("solana.signTransaction", { address: open.solana, bytes: tx }, solTx.signed) as Uint8Array;
  assert.ok(nacl.sign.detached.verify(signedTx.subarray(parseSolanaTransaction(signedTx).messageOffset), signedTx.subarray(1, 65), bs58.decode(open.solana)));
  // Unlimited approvals carry the core's warning.
  const approve = wallet.review("evm.signTransaction", { address: open.evm, transaction: { chainId: 8453, to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", data: `0x095ea7b3${"1".padStart(64, "0")}${"f".repeat(64)}`, value: 0n, gas: 60000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, nonce: 0, type: "eip1559" } }, "https://app.example");
  assert.match(approve.view.warnings.join(" "), /no limit/);
});

test("accounts from one phrase: adding and switching updates what connected sites are told", async () => {
  const before = wallet.snapshot().public!;
  const added = await wallet.addAccount("Second");
  assert.equal(wallet.snapshot().public!.evm, added.evm);
  assert.notEqual(added.evm, before.evm);
  assert.deepEqual(await store.account.read(), { evm: added.evm, solana: added.solana }, "the background's copy follows the open account");
  await wallet.selectAccount(0);
  assert.equal((await store.account.read())!.evm, before.evm);
  // Exports are logged locally, without the secret.
  const phrase = await wallet.revealPhrase("246810");
  const log = await store.activity.all();
  assert.equal(log[0]!.kind, "export");
  assert.ok(!JSON.stringify(log).includes(phrase.split(" ")[0]! + " "));
  await assert.rejects(wallet.revealKeys("000000"), /Wrong PIN/);
});
