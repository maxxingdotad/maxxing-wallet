import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { HDKey } from "@scure/bip32";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { privateKeyToAccount } from "viem/accounts";

/**
 * One recovery phrase (BIP-39, 12 words) for both families. EVM uses m/44'/60'/0'/0/0 (BIP-32). Solana uses m/44'/501'/0'/0'
 * (SLIP-0010 ed25519), the path most Solana wallets use, so the same phrase opens the same Solana account elsewhere.
 */
export type PlatformAccount = {
  mnemonic: string;
  evm: { path: string; privateKeyBytes: Uint8Array; address: `0x${string}` };
  solana: { path: string; secretKey: Uint8Array; address: string };
};

export function bytesToHex(bytes: Uint8Array) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function normalizeMnemonic(mnemonic: string) {
  return mnemonic.trim().toLowerCase().replace(/\s+/g, " ");
}

export function createMnemonic() {
  return generateMnemonic(wordlist, 128);
}

export function mnemonicIsValid(mnemonic: string) {
  return validateMnemonic(normalizeMnemonic(mnemonic), wordlist);
}

/** The most accounts one recovery phrase opens here. */
export const MAX_ACCOUNT_INDEX = 99;
const checkedIndex = (index: number) => { if (!Number.isSafeInteger(index) || index < 0 || index > MAX_ACCOUNT_INDEX) throw new Error("ACCOUNT_INDEX_INVALID"); return index; };

function deriveSolana(seed: Uint8Array, index = 0) {
  const path = `m/44'/501'/${index}'/0'`;
  const I = hmac(sha512, new TextEncoder().encode("ed25519 seed"), seed);
  let key = I.slice(0, 32);
  let chain = I.slice(32, 64);
  I.fill(0);
  const hard = 0x80000000;
  for (const segment of [44 | hard, 501 | hard, (index | hard) >>> 0, 0 | hard]) {
    const data = new Uint8Array(37);
    data[0] = 0;
    data.set(key, 1);
    data[33] = (segment >>> 24) & 0xff;
    data[34] = (segment >>> 16) & 0xff;
    data[35] = (segment >>> 8) & 0xff;
    data[36] = segment & 0xff;
    const next = hmac(sha512, chain, data);
    key.fill(0);chain.fill(0);data.fill(0);
    key = next.slice(0, 32);
    chain = next.slice(32, 64);
    next.fill(0);
  }
  const pair = nacl.sign.keyPair.fromSeed(key);
  key.fill(0);chain.fill(0);
  return { path, secretKey: pair.secretKey, address: bs58.encode(pair.publicKey) };
}

/**
 * The keys of account `index` (0 by default) of a recovery phrase. Account n is EVM m/44'/60'/0'/0/n and Solana m/44'/501'/n'/0',
 * the paths other wallets use for their n-th account, so the same phrase opens the same accounts elsewhere.
 */
export function derivePlatformAccount(mnemonic: string, index = 0): PlatformAccount {
  checkedIndex(index);
  const phrase = normalizeMnemonic(mnemonic);
  if (!validateMnemonic(phrase, wordlist)) throw new Error("INVALID_RECOVERY_PHRASE");
  const seed = mnemonicToSeedSync(phrase);
  const evmPath = `m/44'/60'/0'/0/${index}`;
  const master=HDKey.fromMasterSeed(seed);
  const child = master.derive(evmPath);
  try {
  if (!child.privateKey) throw new Error("EVM_KEY_DERIVATION_FAILED");
  const privateKeyBytes = new Uint8Array(child.privateKey);
  const privateKeyHex = `0x${bytesToHex(privateKeyBytes)}` as const;
  const account = privateKeyToAccount(privateKeyHex);
  return {
    mnemonic: phrase,
    evm: { path: evmPath, privateKeyBytes, address: account.address },
    solana: deriveSolana(seed, index),
  };
  }finally{seed.fill(0);child.wipePrivateData();master.wipePrivateData();}
}
