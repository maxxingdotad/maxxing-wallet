import { test } from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { encodeFunctionData, maxUint160, maxUint256, parseAbi } from "viem";
import { approve, approvalFor, forgetWallet, listApprovals, revoke, touch } from "../src/approvals";
import { isSolanaTransactionMessage, parseSolanaTransaction, signSolanaTransaction } from "../src/solana-tx";
import { bytesForDisplay, messageForDisplay, networkKnown, solanaBytesView, solanaSummary, transactionSummary, typedDataSummary, checkedTransaction } from "../src/review";

// Disposable in-memory storage only.
const data = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) } });

const ACME = { id: "app_0123456789abcdef0123", name: "Acme" };

test("connections are per wallet and per website, and can be removed", () => {
  data.clear();
  assert.equal(approvalFor("w1", ACME.id, "https://acme.example"), null);
  approve("w1", ACME, "https://acme.example", 1000);
  assert.ok(approvalFor("w1", ACME.id, "https://acme.example"));
  assert.equal(approvalFor("w1", ACME.id, "https://evil.example"), null, "another website of the same app id is not connected");
  assert.equal(approvalFor("w2", ACME.id, "https://acme.example"), null, "another wallet is not connected");
  approve("w1", ACME, "https://www.acme.example", 2000);
  assert.deepEqual(listApprovals("w1")[0]!.origins, ["https://acme.example", "https://www.acme.example"]);
  assert.equal(listApprovals("w1")[0]!.approvedAt, 1000);
  approve("w1", { id: "app_ffffffffffffffffffff", name: "Other" }, "https://other.example", 3000);
  touch("w1", ACME.id, 4000);
  assert.deepEqual(listApprovals("w1").map(a => a.name), ["Acme", "Other"], "most recently used first");
  assert.equal(revoke("w1", ACME.id), true);
  assert.equal(revoke("w1", ACME.id), false);
  assert.equal(approvalFor("w1", ACME.id, "https://acme.example"), null);
  forgetWallet("w1");
  assert.deepEqual(listApprovals("w1"), []);
});

test("damaged or forged connection records count as not connected", () => {
  data.clear();
  data.set("maxxing.walletApps.v1", "{not json");
  assert.deepEqual(listApprovals("w1"), []);
  data.set("maxxing.walletApps.v1", JSON.stringify({ version: 1, wallets: { w1: { [ACME.id]: { appId: "app_other", name: "x", origins: ["https://acme.example"], approvedAt: 1, lastUsedAt: 1 } } } }));
  assert.equal(approvalFor("w1", ACME.id, "https://acme.example"), null, "an entry must be filed under its own app id");
  data.set("maxxing.walletApps.v1", JSON.stringify({ version: 1, wallets: { w1: { [ACME.id]: { appId: ACME.id, name: "x", origins: "https://acme.example", approvedAt: 1, lastUsedAt: 1 } } } }));
  assert.equal(approvalFor("w1", ACME.id, "https://acme.example"), null);
});

test("messages are shown as text when they are text", () => {
  assert.deepEqual(messageForDisplay("Sign in to Acme"), { text: "Sign in to Acme", raw: false });
  assert.deepEqual(messageForDisplay({ raw: "0x68656c6c6f" }), { text: "hello", raw: false });
  assert.deepEqual(messageForDisplay({ raw: "0x00ff10" }), { text: "0x00ff10", raw: true });
  assert.throws(() => messageForDisplay(42));
  assert.deepEqual(bytesForDisplay(new TextEncoder().encode("hi")), { text: "hi", raw: false });
  assert.equal(bytesForDisplay(new Uint8Array([0, 255])).raw, true);
});

test("typed data: permits get a spending warning", () => {
  const permit = typedDataSummary({
    domain: { name: "USD Coin", chainId: 84532, verifyingContract: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
    types: { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }] },
    primaryType: "Permit", message: { owner: "0x1", spender: "0x2", value: "1000000" },
  });
  assert.equal(permit.spending, true);
  assert.equal(permit.network, "Base Sepolia (test network)");
  assert.deepEqual(permit.rows, [["owner", "0x1"], ["spender", "0x2"], ["value", "1000000"]]);
  const login = typedDataSummary({ domain: { name: "Acme" }, types: { Login: [{ name: "nonce", type: "string" }] }, primaryType: "Login", message: { nonce: "abc", nested: { deep: { deeper: { deepest: 1 } } } } });
  assert.equal(login.spending, false);
  // Only signed fields show: `nested` is not in the Login type, so it is not signed and not shown.
  assert.deepEqual(login.rows, [["nonce", "abc"]]);
  assert.throws(() => typedDataSummary({ primaryType: "X" }), /EIP712_PAYLOAD_INVALID/);
});

test("networks the chain registry doesn't list are flagged", () => {
  assert.equal(networkKnown(8453), true);
  assert.equal(networkKnown("8453"), true);
  assert.equal(networkKnown(424242424), false);
  assert.equal(networkKnown(undefined), false);
  assert.equal(networkKnown(null), false);
  // Typed data without a network (chainId absent or null) names none, so it is never shown as "Any network" plus a warning.
  for (const chainId of [undefined, null]) {
    assert.equal(typedDataSummary({ domain: { name: "Acme", chainId }, types: { Login: [{ name: "nonce", type: "string" }] }, primaryType: "Login", message: { nonce: "a" } }).network, null);
  }
});

test("transactions show network, amount and the most the fee can be", () => {
  const summary = transactionSummary({ chainId: 84532, to: "0x3333333333333333333333333333333333333333", value: 10n ** 15n, gas: 21000n, maxFeePerGas: 2_000_000_000n, nonce: 3, type: "eip1559" });
  assert.equal(summary.network, "Base Sepolia (test network)");
  assert.equal(summary.amount, "0.001 ETH");
  assert.equal(summary.maxFee, "0.000042 ETH");
  assert.equal(summary.callsContract, false);
  const call = transactionSummary({ chainId: 8453, to: "0x3333333333333333333333333333333333333333", data: "0xa9059cbb0000", gas: 1n, gasPrice: 1n });
  assert.equal(call.amount, "0 ETH");
  assert.equal(call.maxFee, "<0.00000001 ETH");
  assert.equal(call.callsContract, true);
  assert.equal(call.network, "Base");
  assert.throws(() => transactionSummary({ to: "0x3333333333333333333333333333333333333333" }), /INVALID_TRANSACTION/);
});

/** A legacy System Program transfer, built by hand. */
function solTransfer(from: Uint8Array, to: Uint8Array, lamports: bigint, extraSigners = 0) {
  const signers = 1 + extraSigners;
  const message = [signers, 0, 1, 3 + extraSigners, ...from, ...Array.from({ length: extraSigners }, () => [...new Uint8Array(32).fill(5)]).flat(), ...to, ...new Uint8Array(32), ...new Uint8Array(32).fill(1), 1, 2 + extraSigners, 2, 0, 1 + extraSigners, 12, 2, 0, 0, 0];
  const amount = new Uint8Array(8);
  new DataView(amount.buffer).setBigUint64(0, lamports, true);
  const body = new Uint8Array([...message, ...amount]);
  return { tx: new Uint8Array([signers, ...new Uint8Array(64 * signers), ...body]), message: body };
}

test("Solana transactions: read, summarised and signed in the right slot", async () => {
  const pair = nacl.sign.keyPair(), other = nacl.sign.keyPair();
  const signer = bs58.encode(pair.publicKey);
  const { tx, message } = solTransfer(pair.publicKey, other.publicKey, 1_500_000_000n);
  const parsed = parseSolanaTransaction(tx);
  assert.equal(parsed.feePayer, signer);
  assert.deepEqual(parsed.transfers, [{ from: signer, to: bs58.encode(other.publicKey), lamports: 1_500_000_000n }]);
  const summary = solanaSummary(tx, signer);
  assert.deepEqual(summary.rows[0], [`Send to ${bs58.encode(other.publicKey).slice(0, 6)}…${bs58.encode(other.publicKey).slice(-4)}`, "1.5 SOL"]);
  assert.throws(() => solanaSummary(tx, bs58.encode(other.publicKey)), /SIGNER_NOT_IN_TRANSACTION/);
  const signed = await signSolanaTransaction(tx, signer, bytes => nacl.sign.detached(bytes, pair.secretKey));
  assert.ok(nacl.sign.detached.verify(message, signed.subarray(1, 65), pair.publicKey));
  assert.deepEqual(signed.subarray(65), tx.subarray(65), "only the signature slot changes");
  // Truncated, padded or oversized bytes are refused.
  assert.throws(() => parseSolanaTransaction(tx.subarray(0, tx.length - 1)));
  assert.throws(() => parseSolanaTransaction(new Uint8Array([...tx, 0])));
  assert.throws(() => parseSolanaTransaction(new Uint8Array(1300)));
});

test("a transaction can't be signed disguised as a message", () => {
  const pair = nacl.sign.keyPair();
  const { message } = solTransfer(pair.publicKey, pair.publicKey, 1n);
  assert.equal(isSolanaTransactionMessage(message), true);
  assert.equal(isSolanaTransactionMessage(new TextEncoder().encode("Sign in to Acme")), false);
});

// ── Token actions in transactions ──────────────────────────────────────────────

const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const SPENDER = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const UNKNOWN_TOKEN = "0x3333333333333333333333333333333333333333";
const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const tokenAbi = parseAbi([
  "function approve(address spender, uint256 amount)",
  "function increaseAllowance(address spender, uint256 addedValue)",
  "function transfer(address to, uint256 amount)",
  "function transferFrom(address from, address to, uint256 amount)",
  "function setApprovalForAll(address operator, bool approved)",
  "function mint(uint256 amount)",
]);
const permit2Abi = parseAbi(["function approve(address token, address spender, uint160 amount, uint48 expiration)", "function lockdown((address token, address spender)[] approvals)"]);
const call = (to: string, data: `0x${string}`) => transactionSummary({ chainId: 8453, to: to as `0x${string}`, data, value: 0n, gas: 60000n, maxFeePerGas: 1n, type: "eip1559" });

test("token approvals say who may spend what, and warn when there's no limit", () => {
  const limited = call(USDC_BASE, encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [SPENDER, 5_000_000n] }));
  assert.deepEqual(limited.tokenCall, { text: "Lets 0x1111…1111 spend your USDC: 5 USDC", warning: null });
  for (const amount of [maxUint256, 2n ** 255n]) {
    const unlimited = call(USDC_BASE, encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [SPENDER, amount] }));
    assert.equal(unlimited.tokenCall?.text, "Lets 0x1111…1111 spend all your USDC, now and later");
    assert.match(unlimited.tokenCall?.warning ?? "", /no limit/);
  }
  assert.equal(call(USDC_BASE, encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [SPENDER, 2n ** 255n - 1n] })).tokenCall?.warning, null, "just under 2^255 is a stated amount");
  assert.deepEqual(call(USDC_BASE, encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [SPENDER, 0n] })).tokenCall, { text: "Removes 0x1111…1111's permission to spend your USDC", warning: null });
  const increased = call(USDC_BASE, encodeFunctionData({ abi: tokenAbi, functionName: "increaseAllowance", args: [SPENDER, maxUint256] }));
  assert.equal(increased.tokenCall?.text, "Lets 0x1111…1111 spend all your USDC, now and later");
  assert.ok(increased.tokenCall?.warning);
  const unknown = call(UNKNOWN_TOKEN, encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [SPENDER, 42n] }));
  assert.equal(unknown.tokenCall?.text, "Lets 0x1111…1111 spend your token 0x3333…3333: 42 units of token 0x3333…3333");
});

test("token sends show the amount and the recipient", () => {
  assert.deepEqual(call(USDC_BASE, encodeFunctionData({ abi: tokenAbi, functionName: "transfer", args: [RECIPIENT, 12_340_000n] })).tokenCall, { text: "Send 12.34 USDC to 0x2222…2222", warning: null });
  assert.deepEqual(call(USDC_BASE, encodeFunctionData({ abi: tokenAbi, functionName: "transferFrom", args: [SPENDER, RECIPIENT, 1n] })).tokenCall, { text: "Send 0.000001 USDC to 0x2222…2222", warning: null });
  assert.equal(call(UNKNOWN_TOKEN, encodeFunctionData({ abi: tokenAbi, functionName: "transfer", args: [RECIPIENT, 1234n] })).tokenCall?.text, "Send 1234 units of token 0x3333…3333 to 0x2222…2222");
});

test("collection-wide approvals warn; revoking them doesn't", () => {
  const granted = call(UNKNOWN_TOKEN, encodeFunctionData({ abi: tokenAbi, functionName: "setApprovalForAll", args: [SPENDER, true] }));
  assert.equal(granted.tokenCall?.text, "Lets 0x1111…1111 move all your items in this collection");
  assert.match(granted.tokenCall?.warning ?? "", /every item/);
  assert.deepEqual(call(UNKNOWN_TOKEN, encodeFunctionData({ abi: tokenAbi, functionName: "setApprovalForAll", args: [SPENDER, false] })).tokenCall, { text: "Removes 0x1111…1111's access to your items in this collection", warning: null });
});

test("Permit2 approvals read like token approvals", () => {
  const unlimited = call(PERMIT2_ADDRESS, encodeFunctionData({ abi: permit2Abi, functionName: "approve", args: [USDC_BASE, SPENDER, maxUint160, 0] }));
  assert.equal(unlimited.tokenCall?.text, "Lets 0x1111…1111 spend all your USDC, now and later");
  assert.ok(unlimited.tokenCall?.warning);
  assert.deepEqual(call(PERMIT2_ADDRESS, encodeFunctionData({ abi: permit2Abi, functionName: "approve", args: [USDC_BASE, SPENDER, 2_500_000n, 0] })).tokenCall, { text: "Lets 0x1111…1111 spend your USDC: 2.5 USDC", warning: null });
  // Other Permit2 calls are not decoded.
  assert.equal(call(PERMIT2_ADDRESS, encodeFunctionData({ abi: permit2Abi, functionName: "lockdown", args: [[]] })).tokenCall, null);
});

test("anything else stays as app code", () => {
  const other = call(USDC_BASE, encodeFunctionData({ abi: tokenAbi, functionName: "mint", args: [1n] }));
  assert.equal(other.tokenCall, null);
  assert.equal(other.callsContract, true);
  assert.equal(call(USDC_BASE, "0x095ea7b3").tokenCall, null, "a cut-off approve is not decoded");
  assert.equal(transactionSummary({ chainId: 8453, to: RECIPIENT, value: 1n }).tokenCall, null);
});

// ── SPL Token and Token-2022 ────────────────────────────────────────────────────

const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const u64 = (value: bigint) => { const out = new Uint8Array(8); new DataView(out.buffer).setBigUint64(0, value, true); return [...out]; };
/** A legacy transaction with one signer and the given accounts; instructions name accounts by position in `keys`. */
function tokenTx(signer: Uint8Array, keys: string[], instructions: { program: string; accounts: string[]; data: number[] }[]) {
  const all = [bs58.encode(signer), ...keys.filter(k => k !== bs58.encode(signer))];
  for (const ix of instructions) if (!all.includes(ix.program)) all.push(ix.program);
  const index = (key: string) => all.indexOf(key);
  const body = [1, 0, 1, all.length, ...all.flatMap(k => [...bs58.decode(k)]), ...new Uint8Array(32).fill(1), instructions.length,
    ...instructions.flatMap(ix => [index(ix.program), ix.accounts.length, ...ix.accounts.map(index), ix.data.length, ...ix.data])];
  return new Uint8Array([1, ...new Uint8Array(64), ...body]);
}
const someone = () => bs58.encode(nacl.sign.keyPair().publicKey);

test("SPL token sends show the amount and the destination", () => {
  const pair = nacl.sign.keyPair(), me = bs58.encode(pair.publicKey), source = someone(), destination = someone();
  const checked = solanaSummary(tokenTx(pair.publicKey, [source, USDC_MINT, destination], [{ program: TOKEN, accounts: [source, USDC_MINT, destination, me], data: [12, ...u64(1_500_000n), 6] }]), me);
  assert.deepEqual(checked.actions, [{ text: `Send 1.5 USDC to ${destination.slice(0, 6)}…${destination.slice(-4)}`, warning: null }]);
  assert.equal(checked.otherInstructions, 0);
  const plain = solanaSummary(tokenTx(pair.publicKey, [source, destination], [{ program: TOKEN_2022, accounts: [source, destination, me], data: [3, ...u64(42n)] }]), me);
  assert.equal(plain.actions[0]!.text, `Send 42 token units to ${destination.slice(0, 6)}…${destination.slice(-4)}`);
  const otherMint = someone();
  const unknownMint = solanaSummary(tokenTx(pair.publicKey, [source, otherMint, destination], [{ program: TOKEN, accounts: [source, otherMint, destination, me], data: [12, ...u64(2_500n), 3] }]), me);
  assert.equal(unknownMint.actions[0]!.text, `Send 2.5 of token ${otherMint.slice(0, 6)}…${otherMint.slice(-4)} to ${destination.slice(0, 6)}…${destination.slice(-4)}`);
});

test("SPL approvals say who may spend, with a warning", () => {
  const pair = nacl.sign.keyPair(), me = bs58.encode(pair.publicKey), source = someone(), delegate = someone();
  const approved = solanaSummary(tokenTx(pair.publicKey, [source, delegate], [{ program: TOKEN, accounts: [source, delegate, me], data: [4, ...u64(7n)] }]), me);
  assert.equal(approved.actions[0]!.text, `Lets ${delegate.slice(0, 6)}…${delegate.slice(-4)} spend your tokens: up to 7 token units`);
  assert.match(approved.actions[0]!.warning ?? "", /trust/);
  const checked = solanaSummary(tokenTx(pair.publicKey, [source, USDC_MINT, delegate], [{ program: TOKEN_2022, accounts: [source, USDC_MINT, delegate, me], data: [13, ...u64(10_000_000n), 6] }]), me);
  assert.equal(checked.actions[0]!.text, `Lets ${delegate.slice(0, 6)}…${delegate.slice(-4)} spend your tokens: up to 10 USDC`);
});

test("handing over a token account you own gets a strong warning", () => {
  const pair = nacl.sign.keyPair(), me = bs58.encode(pair.publicKey), account = someone(), next = nacl.sign.keyPair().publicKey, nextKey = bs58.encode(next);
  const handover = solanaSummary(tokenTx(pair.publicKey, [account], [{ program: TOKEN, accounts: [account, me], data: [6, 2, 1, ...next] }]), me);
  assert.equal(handover.actions[0]!.text, `Gives control of your token account to ${nextKey.slice(0, 6)}…${nextKey.slice(-4)}`);
  assert.match(handover.actions[0]!.warning ?? "", /can't take it back/);
  const removed = solanaSummary(tokenTx(pair.publicKey, [account], [{ program: TOKEN_2022, accounts: [account, me], data: [6, 2, 0] }]), me);
  assert.equal(removed.actions[0]!.text, "Gives control of your token account to no one");
  assert.match(removed.actions[0]!.warning ?? "", /for good/);
  const other = someone();
  const notMine = solanaSummary(tokenTx(pair.publicKey, [account, other], [{ program: TOKEN, accounts: [account, other], data: [6, 2, 1, ...next] }]), me);
  assert.equal(notMine.actions[0]!.warning, null);
});

test("closing a token account says where its leftover SOL goes", () => {
  const pair = nacl.sign.keyPair(), me = bs58.encode(pair.publicKey), account = someone(), elsewhere = someone();
  assert.deepEqual(solanaSummary(tokenTx(pair.publicKey, [account], [{ program: TOKEN, accounts: [account, me, me], data: [9] }]), me).actions,
    [{ text: "Closes a token account. Its leftover SOL goes to you", warning: null }]);
  const away = solanaSummary(tokenTx(pair.publicKey, [account, elsewhere], [{ program: TOKEN, accounts: [account, elsewhere, me], data: [9] }]), me);
  assert.equal(away.actions[0]!.text, `Closes a token account. Its leftover SOL goes to ${elsewhere.slice(0, 6)}…${elsewhere.slice(-4)}`);
  assert.ok(away.actions[0]!.warning);
});

test("unknown programs and malformed token data stay under other actions", () => {
  const pair = nacl.sign.keyPair(), me = bs58.encode(pair.publicKey), program = someone(), account = someone();
  const unknown = solanaSummary(tokenTx(pair.publicKey, [account], [{ program, accounts: [account], data: [12, 1, 2] }, { program: TOKEN, accounts: [account, me], data: [3, 1, 2] }]), me);
  assert.deepEqual(unknown.actions, []);
  assert.equal(unknown.otherInstructions, 2);
  assert.ok(unknown.rows.some(([label]) => label === "Other actions"));
});

test("transactions: what is shown is what is signed; anything read differently is refused", () => {
  const to = "0x2222222222222222222222222222222222222222";
  // A string amount used to show as 0 while the signature sent it: refused now.
  assert.throws(() => checkedTransaction({ chainId: 1, to, value: "0x3635C9ADC5DEA00000" }), /INVALID_TRANSACTION/);
  assert.throws(() => checkedTransaction({ chainId: 1, to, maxFeePerGas: "999999999999" }), /INVALID_TRANSACTION/);
  // Fields the screen doesn't show are refused, an EIP-7702 authorization list above all.
  assert.throws(() => checkedTransaction({ chainId: 1, to, authorizationList: [{ address: to, chainId: 1, nonce: 0 }] }), /INVALID_TRANSACTION/);
  assert.throws(() => checkedTransaction({ chainId: 1, to: "0x123", value: 1n }), /INVALID_TRANSACTION/);
  assert.throws(() => checkedTransaction({ chainId: 1, to, data: "0xzz" }), /INVALID_TRANSACTION/);
  // Real amounts, as bigints or whole numbers, pass through unchanged and show as they will be signed.
  const tx = checkedTransaction({ chainId: 1, to, value: 10n ** 18n, gas: 21000, maxFeePerGas: 10n ** 9n });
  assert.equal(tx.value, 10n ** 18n);
  assert.equal(tx.gas, 21000n);
  assert.equal(transactionSummary(tx).amount, "1 ETH");
});

test("typed data: unsigned keys never push the signed fields off the screen, and an oversized request is refused", () => {
  const filler = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`junk${i}`, "x"]));
  const summary = typedDataSummary({
    types: { Order: [{ name: "taker", type: "address" }, { name: "amount", type: "uint256" }] },
    primaryType: "Order", message: { ...filler, taker: "0x3", amount: "5" },
  });
  assert.deepEqual(summary.rows, [["taker", "0x3"], ["amount", "5"]]);
  assert.equal(summary.spending, true, "a field that names a taker warns");
  const many = Array.from({ length: 70 }, (_, i) => ({ name: `f${i}`, type: "uint256" }));
  assert.throws(() => typedDataSummary({ types: { Big: many }, primaryType: "Big", message: Object.fromEntries(many.map(f => [f.name, "1"])) }), /EIP712_TOO_LARGE/);
});

test("Solana bytes to sign are shown as the transaction they are, or as a message", () => {
  const pair = nacl.sign.keyPair(), other = nacl.sign.keyPair(), me = bs58.encode(pair.publicKey);
  const { message } = solTransfer(pair.publicKey, other.publicKey, 2_000_000_000n);
  const asTransaction = solanaBytesView(message, me);
  assert.equal(asTransaction.kind, "transaction");
  assert.equal(asTransaction.kind === "transaction" && asTransaction.summary.rows[0]![1], "2 SOL", "a transaction message can't pass as a message");
  assert.deepEqual(solanaBytesView(new TextEncoder().encode("Sign in to Acme"), me), { kind: "message", text: "Sign in to Acme", raw: false });
  assert.throws(() => solanaBytesView(message, bs58.encode(other.publicKey)), /SIGNER_NOT_IN_TRANSACTION/);
  assert.throws(() => solanaBytesView(new Uint8Array(), me), /INVALID_SIGN_REQUEST/);
});
