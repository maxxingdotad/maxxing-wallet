import type { Address, Hex, TransactionSerializable, TypedDataDefinition } from "viem";
import { platformEvmAccount, platformSolanaSign } from "./vault";

/** Signing happens here, next to the key. Only signatures leave the frame. */
function evm() {
  const account = platformEvmAccount();
  if (!account) throw new Error("WALLET_LOCKED");
  return account;
}

export async function evmAddress(): Promise<Address> {
  return evm().address;
}

export async function evmSignMessage(params: { message: string | { raw: Hex } }): Promise<Hex> {
  const message = params?.message;
  if (typeof message !== "string" && !(message && typeof message === "object" && typeof (message as { raw?: unknown }).raw === "string")) throw new Error("INVALID_SIGN_REQUEST");
  return evm().signMessage({ message });
}

export async function evmSignTypedData(params: TypedDataDefinition): Promise<Hex> {
  if (!params?.domain || !params.types || !params.primaryType || !params.message) throw new Error("EIP712_PAYLOAD_INVALID");
  return evm().signTypedData(params);
}

export async function evmSignTransaction(params: { transaction: TransactionSerializable }): Promise<Hex> {
  const transaction = params?.transaction;
  if (!transaction || typeof transaction !== "object" || typeof transaction.chainId !== "number" || transaction.chainId <= 0) throw new Error("INVALID_TRANSACTION");
  return evm().signTransaction(transaction);
}

/**
 * The only contract the wallet lets an account delegate to (EIP-7702): Relay's Calibur, which gasless trades run through. It has one address on
 * every chain (`CALIBUR_ADDRESS` in @relayprotocol/relay-sdk; the API checks the same). A delegation hands the account's code to that
 * contract, so the hidden frame, which signs without a prompt, never signs one for any other address, whatever the page or API asks.
 */
export const ALLOWED_DELEGATE = "0x000000009B1D0aF20D8C6d0A44e162d11F9b8f00";

export async function evmSignAuthorization(params: { address: Address; chainId: number; nonce: number }) {
  if (!params || !Number.isSafeInteger(params.chainId) || params.chainId <= 0 || !Number.isSafeInteger(params.nonce) || params.nonce < 0) throw new Error("RELAY_AUTHORIZATION_INVALID");
  if (typeof params.address !== "string" || params.address.toLowerCase() !== ALLOWED_DELEGATE.toLowerCase()) throw new Error("RELAY_AUTHORIZATION_DELEGATE");
  return evm().signAuthorization({ address: params.address, chainId: params.chainId, nonce: params.nonce });
}

/** Solana messages and transactions are both signed as bytes: a transaction's serialized message, or a sign-in text. */
export async function solanaSignBytes(params: { bytes: Uint8Array }): Promise<Uint8Array> {
  const bytes = params?.bytes;
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > 4096) throw new Error("INVALID_SIGN_REQUEST");
  return platformSolanaSign(bytes);
}
