/**
 * Token approvals: permissions this wallet gave a contract to spend a token (ERC-20 approve, EIP-2612 and DAI-style permits,
 * Permit2 allowances) or move a collection (setApprovalForAll). The wallet notes each one it signs, then reads what is still open
 * from the chain itself, so a revoked, spent or expired allowance disappears. Approvals given from another wallet aren't known here.
 */
import { decodeFunctionData, decodeAbiParameters, encodeFunctionData, formatUnits, getAddress, isAddress, maxUint256, parseAbi, type Hex } from "viem";
import { knownEvmToken } from "@maxxing/wallet-core/review";
import { PERMIT2 } from "@maxxing/wallet-core/chains";
import { evmNetwork, type Network } from "./chains";
import { kept } from "./store";
import { rpc } from "./rpc";

const ABI = parseAbi([
  "function approve(address spender, uint256 amount)",
  "function increaseAllowance(address spender, uint256 addedValue)",
  "function setApprovalForAll(address operator, bool approved)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);
/** Permit2 keeps its own allowances per (owner, token, spender), with an expiry. */
const PERMIT2_ABI = parseAbi([
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
]);
const MAX_UINT160 = 2n ** 160n - 1n;
const isPermit2 = (address: string | null | undefined) => !!address && address.toLowerCase() === PERMIT2.toLowerCase();

/** "token": an ERC-20 allowance; "permit2": an allowance kept in Permit2; "collection": access to every item of an NFT collection. */
export type ApprovalKind = "token" | "permit2" | "collection";
export type ApprovalRecord = { networkId: string; token: string; spender: string; kind: ApprovalKind; origin?: string; at: number };
export type GivenApproval = Omit<ApprovalRecord, "at" | "origin">;
const key = (r: Pick<ApprovalRecord, "networkId" | "token" | "spender" | "kind">) => `${r.networkId}:${r.token.toLowerCase()}:${r.spender.toLowerCase()}:${r.kind}`;

export const approvals = {
  all: () => kept.get<ApprovalRecord[]>("approvals", []),
  /** Notes an approval just signed (kept: the newest 300). Signing the same one again moves it to the top. */
  note: (r: GivenApproval & { origin?: string }) => kept.update<ApprovalRecord[]>("approvals", [], all =>
    [{ ...r, token: getAddress(r.token), spender: getAddress(r.spender), at: Date.now() }, ...all.filter(x => key(x) !== key(r))].slice(0, 300)),
  forget: (r: Pick<ApprovalRecord, "networkId" | "token" | "spender" | "kind">) => kept.update<ApprovalRecord[]>("approvals", [], all => all.filter(x => key(x) !== key(r))),
};

const positive = (v: unknown) => { try { return BigInt(String(v ?? "0")) > 0n; } catch { return false; } };

/** The approval a transaction gives, if it gives one (a zero amount or `false` is a revoke, not an approval). */
export function approvalInTransaction(chainId: number, tx: { to?: string | null; data?: string | null }): GivenApproval | null {
  const network = evmNetwork(chainId);
  if (!network || !tx.to || !isAddress(tx.to) || !tx.data || tx.data.length < 10) return null;
  if (isPermit2(tx.to)) {
    try {
      const call = decodeFunctionData({ abi: PERMIT2_ABI, data: tx.data as Hex });
      if (call.functionName === "approve" && call.args[2] > 0n) return { networkId: network.networkId, token: call.args[0], spender: call.args[1], kind: "permit2" };
    } catch { /* another Permit2 call */ }
    return null;
  }
  try {
    const call = decodeFunctionData({ abi: ABI, data: tx.data as Hex });
    if ((call.functionName === "approve" || call.functionName === "increaseAllowance") && (call.args[1] as bigint) > 0n)
      return { networkId: network.networkId, token: tx.to, spender: call.args[0] as string, kind: "token" };
    if (call.functionName === "setApprovalForAll" && call.args[1] === true)
      return { networkId: network.networkId, token: tx.to, spender: call.args[0] as string, kind: "collection" };
  } catch { /* not an approval */ }
  return null;
}

/**
 * The approvals a signed message gives: an EIP-2612 permit (value), a DAI-style permit (allowed: true), or a Permit2
 * PermitSingle / PermitBatch (each token's amount, for the spender). Anything else gives none.
 */
export function approvalsInPermit(typedData: unknown): GivenApproval[] {
  type Details = { token?: string; amount?: unknown };
  const t = typedData as { primaryType?: string; domain?: { chainId?: unknown; verifyingContract?: string }; message?: { spender?: string; value?: unknown; allowed?: unknown; details?: Details | Details[] } } | null;
  const network = t?.domain ? evmNetwork(Number(t.domain.chainId)) : null;
  const contract = t?.domain?.verifyingContract, spender = t?.message?.spender;
  if (!network || !contract || !isAddress(contract) || !spender || !isAddress(spender)) return [];
  if (isPermit2(contract) && (t!.primaryType === "PermitSingle" || t!.primaryType === "PermitBatch")) {
    const details = Array.isArray(t!.message!.details) ? t!.message!.details : t!.message!.details ? [t!.message!.details] : [];
    return details.filter(d => d.token && isAddress(d.token) && positive(d.amount))
      .map(d => ({ networkId: network.networkId, token: d.token!, spender, kind: "permit2" as const }));
  }
  if (t!.primaryType !== "Permit") return [];
  const message = t!.message!;
  const gives = "allowed" in message ? message.allowed === true : positive(message.value); // DAI's permit: allowed; EIP-2612: value
  return gives ? [{ networkId: network.networkId, token: contract, spender, kind: "token" }] : [];
}

export type LiveApproval = ApprovalRecord & { symbol: string; amount: string; unlimited: boolean; /** The registry knows this token. */ verified: boolean };
const call = (network: Network, to: string, data: Hex) => rpc<Hex>(network.rpc, "eth_call", [{ to, data }, "latest"]);

/**
 * What is still open, read from each approval's chain now: the allowance left, or whether the collection access stands. Ones the
 * chain no longer shows (revoked, spent, expired) are left out; ones the chain didn't answer for are kept with amount "unknown".
 */
export async function readApprovals(owner: string, records: readonly ApprovalRecord[], networks: readonly Network[], now = Date.now()): Promise<LiveApproval[]> {
  const byId = new Map(networks.map(n => [n.networkId, n]));
  const out = await Promise.all(records.map(async (r): Promise<LiveApproval | null> => {
    const network = byId.get(r.networkId);
    if (!network?.evmChainId) return null;
    const known = knownEvmToken(network.evmChainId, r.token), verified = !!known;
    try {
      if (r.kind === "collection") {
        const raw = await call(network, r.token, encodeFunctionData({ abi: ABI, functionName: "isApprovedForAll", args: [owner as Hex, r.spender as Hex] }));
        return BigInt(raw) === 0n ? null : { ...r, symbol: known?.symbol ?? "Collection", amount: "All items", unlimited: true, verified };
      }
      let raw: bigint;
      if (r.kind === "permit2") {
        const answer = await call(network, PERMIT2, encodeFunctionData({ abi: PERMIT2_ABI, functionName: "allowance", args: [owner as Hex, r.token as Hex, r.spender as Hex] }));
        const [amount, expiration] = decodeAbiParameters([{ type: "uint160" }, { type: "uint48" }, { type: "uint48" }], answer);
        if (Number(expiration) * 1000 <= now) return null; // expired: nothing left to spend
        raw = amount;
      } else raw = BigInt(await call(network, r.token, encodeFunctionData({ abi: ABI, functionName: "allowance", args: [owner as Hex, r.spender as Hex] })));
      if (raw === 0n) return null;
      const meta = known ?? await tokenMeta(network, r.token);
      const unlimited = r.kind === "permit2" ? raw >= MAX_UINT160 : raw >= 2n ** 255n || raw === maxUint256;
      return { ...r, symbol: meta.symbol, amount: unlimited ? "Unlimited" : `${formatUnits(raw, meta.decimals)} ${meta.symbol}`, unlimited, verified };
    } catch {
      return { ...r, symbol: known?.symbol ?? "Token", amount: "unknown", unlimited: false, verified };
    }
  }));
  return out.filter((x): x is LiveApproval => !!x);
}

async function tokenMeta(network: Network, token: string) {
  const [symbol, decimals] = await Promise.all([
    call(network, token, encodeFunctionData({ abi: ABI, functionName: "symbol" })).then(raw => decodeString(raw)).catch(() => "Token"),
    call(network, token, encodeFunctionData({ abi: ABI, functionName: "decimals" })).then(raw => Number(BigInt(raw))).catch(() => 18),
  ]);
  return { symbol: symbol.replace(/[^\x20-\x7e]/g, "").slice(0, 16) || "Token", decimals: decimals >= 0 && decimals <= 36 ? decimals : 18 };
}
function decodeString(raw: Hex) {
  const hex = raw.slice(2);
  if (hex.length < 128) return "Token";
  const length = Number(BigInt(`0x${hex.slice(64, 128)}`));
  const bytes = hex.slice(128, 128 + length * 2).match(/../g) ?? [];
  return new TextDecoder().decode(Uint8Array.from(bytes.map(b => parseInt(b, 16))));
}

/** The call that takes an approval back: approve(spender, 0), Permit2's approve(token, spender, 0, 0), or setApprovalForAll(…, false). */
export function revokeCall(r: Pick<ApprovalRecord, "token" | "spender" | "kind">): { to: string; data: Hex } {
  if (r.kind === "collection") return { to: r.token, data: encodeFunctionData({ abi: ABI, functionName: "setApprovalForAll", args: [r.spender as Hex, false] }) };
  if (r.kind === "permit2") return { to: PERMIT2, data: encodeFunctionData({ abi: PERMIT2_ABI, functionName: "approve", args: [r.token as Hex, r.spender as Hex, 0n, 0] }) };
  return { to: r.token, data: encodeFunctionData({ abi: ABI, functionName: "approve", args: [r.spender as Hex, 0n] }) };
}
