/**
 * Logos, bundled (the pages load no remote image): chains by the registry's chain key, tokens by symbol, from @web3icons (the same
 * set the MAXXING web app uses). A chain or token without one gets its initial on a quiet disc. Which chains exist, and their keys,
 * comes from the chain registry; this file only says what each key looks like.
 */
import type { ComponentType } from "react";
import { getChain } from "@maxxing/wallet-core/chains";
import NetworkEthereum from "@web3icons/react/icons/networks/NetworkEthereum";
import NetworkBase from "@web3icons/react/icons/networks/NetworkBase";
import NetworkRobinhood from "@web3icons/react/icons/networks/NetworkRobinhood";
import NetworkArbitrumOne from "@web3icons/react/icons/networks/NetworkArbitrumOne";
import NetworkOptimism from "@web3icons/react/icons/networks/NetworkOptimism";
import NetworkBinanceSmartChain from "@web3icons/react/icons/networks/NetworkBinanceSmartChain";
import NetworkPolygon from "@web3icons/react/icons/networks/NetworkPolygon";
import NetworkAvalanche from "@web3icons/react/icons/networks/NetworkAvalanche";
import NetworkLinea from "@web3icons/react/icons/networks/NetworkLinea";
import NetworkMonad from "@web3icons/react/icons/networks/NetworkMonad";
import NetworkHyperEvm from "@web3icons/react/icons/networks/NetworkHyperEvm";
import NetworkMegaEth from "@web3icons/react/icons/networks/NetworkMegaEth";
import NetworkInk from "@web3icons/react/icons/networks/NetworkInk";
import NetworkWorld from "@web3icons/react/icons/networks/NetworkWorld";
import NetworkArc from "@web3icons/react/icons/networks/NetworkArc";
import NetworkCelo from "@web3icons/react/icons/networks/NetworkCelo";
import NetworkSonic from "@web3icons/react/icons/networks/NetworkSonic";
import NetworkUnichain from "@web3icons/react/icons/networks/NetworkUnichain";
import NetworkSolana from "@web3icons/react/icons/networks/NetworkSolana";
import TokenETH from "@web3icons/react/icons/tokens/TokenETH";
import TokenSOL from "@web3icons/react/icons/tokens/TokenSOL";
import TokenUSDC from "@web3icons/react/icons/tokens/TokenUSDC";
import TokenUSDT from "@web3icons/react/icons/tokens/TokenUSDT";
import TokenDAI from "@web3icons/react/icons/tokens/TokenDAI";
import TokenBNB from "@web3icons/react/icons/tokens/TokenBNB";
import TokenPOL from "@web3icons/react/icons/tokens/TokenPOL";
import TokenAVAX from "@web3icons/react/icons/tokens/TokenAVAX";
import TokenCELO from "@web3icons/react/icons/tokens/TokenCELO";
import TokenMON from "@web3icons/react/icons/tokens/TokenMON";
import TokenHYPE from "@web3icons/react/icons/tokens/TokenHYPE";

type Icon = ComponentType<{ size?: number; variant?: "branded" | "mono" | "background" }>;

/** Registry chain key → logo. Test networks share their mainnet's logo (the base key before "_sepolia"/"_devnet"). */
const CHAIN: Record<string, Icon> = {
  ethereum: NetworkEthereum, sepolia: NetworkEthereum, base: NetworkBase, robinhood: NetworkRobinhood, arbitrum: NetworkArbitrumOne,
  optimism: NetworkOptimism, op: NetworkOptimism, bsc: NetworkBinanceSmartChain, polygon: NetworkPolygon, avalanche: NetworkAvalanche,
  linea: NetworkLinea, monad: NetworkMonad, hyperevm: NetworkHyperEvm, megaeth: NetworkMegaEth, ink: NetworkInk, world: NetworkWorld,
  arc: NetworkArc, celo: NetworkCelo, sonic: NetworkSonic, unichain: NetworkUnichain, solana: NetworkSolana,
};
const TOKEN: Record<string, Icon> = {
  ETH: TokenETH, WETH: TokenETH, SOL: TokenSOL, USDC: TokenUSDC, USDT: TokenUSDT, DAI: TokenDAI, BNB: TokenBNB, POL: TokenPOL,
  AVAX: TokenAVAX, CELO: TokenCELO, MON: TokenMON, HYPE: TokenHYPE,
};

const chainKey = (networkId: string) => { try { return getChain(networkId)?.key ?? ""; } catch { return ""; } };
export function chainIcon(networkId: string): Icon | null {
  const key = chainKey(networkId);
  return CHAIN[key] ?? CHAIN[key.replace(/_(sepolia|devnet|testnet)$/, "")] ?? null;
}

function Letter({ text, size, color }: { text: string; size: number; color?: string }) {
  return <span aria-hidden="true" style={{ width: size, height: size, borderRadius: 999, display: "inline-grid", placeItems: "center", background: color ?? "var(--surface-3)", color: "var(--text-2)", fontSize: Math.round(size * 0.42), fontWeight: 700, flexShrink: 0 }}>{text.slice(0, 1).toUpperCase()}</span>;
}

export function ChainLogo({ networkId, name, size = 20 }: { networkId: string; name: string; size?: number }) {
  const Logo = chainIcon(networkId);
  // Base's mark is a small blue square with empty space around it: its tile is filled with the same blue, so it reads as one
  // solid mark like the others (and as a round dot when it is a token's badge).
  const fill = networkId === "eip155:8453" || networkId === "eip155:84532" ? "#00F" : undefined;
  return Logo ? <span aria-hidden="true" className="chain-logo" style={{ display: "inline-grid", width: size, height: size, flexShrink: 0, background: fill }}><Logo size={size} variant="branded" /></span> : <Letter text={name} size={size} />;
}

/**
 * A token's logo. The branded mark only for a verified token (the registry's, or a coin): anyone can name a token "USDC", so an
 * unverified one gets a neutral letter mark, never a real brand's logo.
 */
export function TokenLogo({ symbol, size = 36, verified = false }: { symbol: string; size?: number; verified?: boolean }) {
  const Logo = verified ? TOKEN[symbol.toUpperCase()] : undefined;
  return Logo ? <span aria-hidden="true" style={{ display: "inline-grid", width: size, height: size, flexShrink: 0 }}><Logo size={size} variant="branded" /></span> : <Letter text={symbol} size={size} />;
}
