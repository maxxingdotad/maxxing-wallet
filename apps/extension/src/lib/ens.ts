/**
 * ENS names (name.eth) to addresses, read from Ethereum through the registry's public endpoints and the extension's own reviewed
 * rpc(), at the universal resolver the registry names. Offchain lookups (CCIP-Read) are off, so a name's resolver can't make the wallet call other URLs; names that only resolve
 * offchain say "no address". The wallet always sends to the address shown, never to the name.
 */
import { createPublicClient, custom, getAddress } from "viem";
import { normalize } from "viem/ens";
import { networks } from "./chains";
import { rpc } from "./rpc";

/** Only .eth names: other suffixes are DNS names whose ownership ENS doesn't control in the same way. */
export const isEnsName = (text: string) => /^[^\s./]+(\.[^\s./]+)*\.eth$/i.test(text.trim());

export async function resolveEns(name: string): Promise<string | null> {
  if (!isEnsName(name)) return null;
  // The chain where ENS lives, and its universal resolver, both from the registry.
  const home = networks(false).find(n => n.family === "EVM" && n.ens?.universalResolver);
  if (!home?.ens || !home.evmChainId) return null;
  let normalized: string;
  try { normalized = normalize(name.trim()); } catch { return null; } // not a valid ENS name (e.g. hidden look-alike characters)
  const client = createPublicClient({
    transport: custom({ request: ({ method, params }: { method: string; params?: unknown }) => rpc(home.rpc, method, (params ?? []) as unknown[]) }),
    ccipRead: false,
  });
  try {
    const address = await client.getEnsAddress({ name: normalized, universalResolverAddress: home.ens.universalResolver as `0x${string}` });
    return address ? getAddress(address) : null;
  } catch { return null; }
}
