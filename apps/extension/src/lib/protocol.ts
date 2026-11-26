/**
 * The messages between the extension's parts. A site's request travels: in-page provider → content script (window messages) →
 * background (runtime message) → approval window. The answer comes back from the approval window straight to the content script
 * of the tab that asked (tab message), so a background that Chrome stopped meanwhile loses nothing.
 */

/** What the in-page provider may ask: the same methods the MAXXING SDK's providers send to the wallet window. */
export const SITE_METHODS = ["connect", "evm.signMessage", "evm.signTypedData", "evm.signTransaction", "solana.signMessage", "solana.signTransaction", "evm.switchChain"] as const;
export type SiteMethod = (typeof SITE_METHODS)[number];
export const isSiteMethod = (method: unknown): method is SiteMethod => typeof method === "string" && (SITE_METHODS as readonly string[]).includes(method);

/** Page ↔ content script, over window.postMessage. Tagged so other scripts' messages are ignored. */
export const PAGE_CHANNEL = "maxxing-wallet-extension";
export type PageRequest = { channel: typeof PAGE_CHANNEL; dir: "to-wallet"; id: string; method: SiteMethod; params?: unknown };
export type PageResponse = { channel: typeof PAGE_CHANNEL; dir: "to-page"; id: string; ok: true; result: unknown } | { channel: typeof PAGE_CHANNEL; dir: "to-page"; id: string; ok: false; error: { message: string; code?: number } };
/** `chainId`: the network the wallet keeps for this site; the page's provider moves to it. */
export type PageEvent = { channel: typeof PAGE_CHANNEL; dir: "to-page"; event: "accountsChanged" | "disconnect"; connection: { evm: string; solana: string; chainId?: number } | null };

/** Content script → background. `params` are encoded (codec.ts). */
export type SiteRequest = { type: "site-request"; id: string; method: SiteMethod; params?: unknown };
/** The background's answer: done now, or waiting for the approval window, which will answer the tab directly. */
export type SiteAnswer = { done: true; ok: true; result: unknown } | { done: true; ok: false; error: { message: string; code?: number } } | { done: false };

/**
 * Approval window → the tab's content script. It is addressed to the exact document that asked (`documentId`), and it names that
 * document's origin, so a tab that has moved on to another page drops it.
 */
export type TabAnswer = ({ type: "site-answer"; id: string; ok: true; result: unknown } | { type: "site-answer"; id: string; ok: false; error: { message: string; code?: number } }) & { origin: string };

/** A request waiting for the user, kept in session storage under `pending:<id>` so the approval window can read it. */
export type Pending = {
  id: string; /** The id the page's provider is waiting on. */ requestId: string; method: SiteMethod; params: unknown; origin: string;
  tabId: number; frameId: number; /** The page that asked; answers go to it alone. */ documentId?: string;
  createdAt: number; windowId?: number;
  /** "blocked": a known scam, stopped. "lookalike": a name that reads as MAXXING, warned first; `next` is what follows if the user goes on. */
  kind: "connect" | "sign" | "blocked" | "lookalike" | "switch"; next?: "connect" | "sign";
  /** The user went past the look-alike warning for this request; the site is trusted only if they approve it. */
  passedLookalikeWarning?: boolean;
};

/** Limits on what a site can ask for. */
export const LIMITS = {
  /** Size of a request's parameters, encoded. A large typed-data message fits; a page can't fill the browser's memory. */
  paramsBytes: 256 * 1024,
  idLength: 100,
  /** A site whose requests the user turned down this many times in a minute waits until the minute is over (spam gets declined). */
  declinesPerMinute: 3,
  /** And a backstop: approval windows one site may open per minute, approved or not. */
  windowsPerMinute: 20,
  /** Block screens one listed site may cause per minute, across tabs. */
  blockScreensPerMinute: 3,
  /** How long the "continue anyway" on a look-alike warning waits after the box is ticked. */
  lookalikeWaitMs: 3000,
  /** How long the approve buttons wait after the window shows or gets focus back, so a click meant for the site can't land on them. */
  armDelayMs: 750,
} as const;

/** EIP-1193 codes the providers already understand. */
export const ERRORS = {
  rejected: { message: "User rejected the request.", code: 4001 },
  unauthorized: { message: "Connect the wallet to this site first.", code: 4100 },
  otherAccount: { message: "This site was connected with another account. Connect it again to use this one.", code: 4100 },
  unsupported: { message: "This method isn't supported.", code: 4200 },
  blocked: { message: "MAXXING blocked this site: it's on the phishing blocklist.", code: 4001 },
  locked: { message: "The wallet is locked.", code: 4100 },
  busy: { message: "Another request from this site is already waiting in the MAXXING window.", code: 4001 },
  tooMany: { message: "Too many requests from this site. Wait a minute and try again.", code: 4001 },
  tooLarge: { message: "This request is too large to show.", code: 4001 },
  unknownChain: { message: "MAXXING Wallet doesn't support this network.", code: 4902 },
  testnetsOff: { message: "This is a test network. Turn on test networks in MAXXING Wallet's settings first.", code: 4902 },
} as const;
