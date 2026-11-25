import type { Account, ChainMark, Holding } from "../ui/parts";

/** Sample data for the design gallery only. The extension reads real balances from the public API. */
export const CHAINS: Record<string, ChainMark> = {
  base: { id: "base", name: "Base", color: "#3B6FF6", logo: "/brand/base-symbol.webp" },
  ethereum: { id: "ethereum", name: "Ethereum", color: "#8C9BF0", logo: "/brand/eth-symbol.webp" },
  solana: { id: "solana", name: "Solana", color: "#9B6BFF", logo: "/brand/sol-symbol.webp" },
  arbitrum: { id: "arbitrum", name: "Arbitrum", color: "#4FB4F7" },
  robinhood: { id: "robinhood", name: "Robinhood Chain", color: "#C4C6CC" },
};

export const ACCOUNTS: Account[] = [
  { id: "a1", name: "Main", color: "#E8E4DC", evm: "0x7a3F9c2E41b08D5e6A9f1C0d2B4e7F8a9C0d3E21", solana: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", usd: 12480.62, kind: "phrase" },
  { id: "a2", name: "Trading", color: "#A36AFF", evm: "0x51c0E6b7aA2d9F3e8C4B1a0D7e6F5c4B3a2E1f90", solana: "7Hk2p6d1vqzN9wYxLmR4tSsBcA8eFg3JhUjKqPz5oW1", usd: 3120.4, kind: "phrase" },
  { id: "a3", name: "Vault", color: "#3CB07A", evm: "0x0D9e8F7a6B5c4D3e2F1a0B9c8D7e6F5a4B3c2D11", solana: "4Rt8sQe2vXz7YpNw3KmL9hJ6gF5dC1bA2sD3fG4hJ5k", usd: 41000, kind: "phrase" },
  { id: "a4", name: "Old desktop wallet", color: "#D4B15A", evm: "0x9C8b7A6f5E4d3C2b1A0f9E8d7C6b5A4f3E2d1C0b", solana: "", usd: 212.33, kind: "imported" },
];

export const HOLDINGS: Holding[] = [
  { symbol: "MAXX", name: "MAXXING", chain: CHAINS.base!, amount: "184,200", usd: 4210.77, change: 12.4, logo: "/brand/cap-neutral.webp" },
  { symbol: "ETH", name: "Ether", chain: CHAINS.base!, amount: "0.8421", usd: 2984.1, change: 1.8, logo: "/brand/eth-symbol.webp" },
  { symbol: "SOL", name: "Solana", chain: CHAINS.solana!, amount: "11.42", usd: 2410.5, change: -2.3, logo: "/brand/sol-symbol.webp" },
  { symbol: "USDC", name: "USD Coin", chain: CHAINS.arbitrum!, amount: "1,620.00", usd: 1620, change: 0, color: "#3E73C4" },
  { symbol: "USDG", name: "Global Dollar", chain: CHAINS.robinhood!, amount: "880.25", usd: 880.25, change: 0, color: "#2F8F83" },
  { symbol: "ETH", name: "Ether", chain: CHAINS.ethereum!, amount: "0.1043", usd: 375, change: 1.8, logo: "/brand/eth-symbol.webp" },
];
