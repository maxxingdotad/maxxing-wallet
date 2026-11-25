#!/usr/bin/env node
/**
 * Pins Relay's contracts for every EVM network in MAXXING's chain registry that Relay serves, into src/lib/relay-pinned.json:
 * - approvalProxies and depositories: the only contracts the wallet lets spend a token for a swap;
 * - contracts: every contract a Relay transaction may be sent to (routers, receivers, multicallers, approval proxies,
 *   depositories). Solvers' own addresses are never pinned: no transaction, and no coin, goes to them.
 * Each address comes from Relay's public chain list (https://api.relay.link/chains) and is checked on that network: it must have
 * contract code, read through the registry's public RPC, or Relay's own RPC for the network when none of those answers. Review
 * the diff before committing; the wallet pauses token-spending swaps on a network whose live list no longer matches this file.
 *
 *   tsx scripts/pin-relay-contracts.mjs
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SDK_CHAINS, browserRpcUrls } from "@maxxing/wallet-sdk";

const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { chains } = await (await fetch("https://api.relay.link/chains")).json();

/**
 * Extra public endpoints used only here, to read contract code when neither the registry's nor Relay's endpoint for a network
 * answers (World Chain: its registry endpoints and Relay's were down when this was written). Keyless; never used by the wallet.
 */
const VERIFY_ONLY = { 480: ["https://worldchain-mainnet.g.alchemy.com/public"] };

const codeAt = async (urls, address) => {
  for (const url of urls) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [address, "latest"] }), signal: AbortSignal.timeout(10_000) });
      const body = await r.json();
      if (typeof body?.result === "string") return body.result;
    } catch { /* next endpoint */ }
  }
  return null;
};

const pinned = {};
const skipped = [];
for (const chain of SDK_CHAINS.filter(c => c.family === "EVM" && !c.testnet && c.evmChainId != null)) {
  const relay = chains.find(c => Number(c.id) === chain.evmChainId);
  if (!relay) { skipped.push(`${chain.name}: Relay doesn't serve it`); continue; }
  const approvalProxies = new Set(), depositories = new Set(), receivers = new Set(), routers = new Set(), contracts = new Set();
  const collect = (v, key = "") => {
    if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) {
      const a = v.toLowerCase();
      contracts.add(a);
      if (key === "approvalProxy") approvalProxies.add(a);
      if (key === "depository") depositories.add(a);
      if (key === "relayReceiver") receivers.add(a);
      if (key === "erc20Router") routers.add(a);
    } else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) collect(x, Array.isArray(v) ? key : k);
  };
  collect(relay.contracts); collect(relay.protocol); // not relay.solverAddresses
  const urls = [...browserRpcUrls(chain), ...(typeof relay.httpRpcUrl === "string" ? [relay.httpRpcUrl] : []), ...(VERIFY_ONLY[chain.evmChainId] ?? [])];
  const verified = { approvalProxies: [], depositories: [], receivers: [], routers: [], contracts: [] };
  for (const [kind, set] of [["approvalProxies", approvalProxies], ["depositories", depositories], ["receivers", receivers], ["routers", routers], ["contracts", contracts]]) for (const address of [...set].sort()) {
    const code = await codeAt(urls, address);
    if (code === null) { skipped.push(`${chain.name}: couldn't read ${address}`); continue; }
    if (code === "0x") { skipped.push(`${chain.name}: no contract at ${address}`); continue; }
    verified[kind].push(address);
  }
  if (!verified.approvalProxies.length && !verified.depositories.length) { skipped.push(`${chain.name}: nothing verified`); continue; }
  pinned[chain.evmChainId] = { name: chain.name, ...verified };
}

const out = {
  about: "Relay's contracts per EVM chain. approvalProxies and depositories: the only token spenders the wallet allows. contracts: the only addresses a Relay transaction may go to; solver addresses are never included. Coins may be sent only to depositories and receivers, or to a router for a swap on one network (exactly the amount). From https://api.relay.link/chains (contracts.*, protocol.*); each address verified to hold contract code on that chain via the chain registry's public RPC, or Relay's RPC for the chain when none answered. Regenerate with scripts/pin-relay-contracts.mjs and review the diff.",
  checkedOn: new Date().toISOString().slice(0, 10),
  chains: pinned,
};
writeFileSync(resolve(here, "src/lib/relay-pinned.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`${Object.keys(pinned).length} networks pinned.`);
for (const s of skipped) console.log(`  skipped: ${s}`);
