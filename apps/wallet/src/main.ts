import { WALLET_PROTOCOL, WALLET_PROTOCOL_VERSION, type WalletEvent, type WalletRequest, type WalletResponse, type WalletScreen } from "./protocol";import { appForOrigin } from "./registry";
import * as vault from "@maxxing/wallet-core/vault";
import * as signing from "@maxxing/wallet-core/signing";
import { walletState } from "./state";
import { closeScreens, openApproval, openScreen, SCREENS } from "./ui/screens";
import * as approvals from "@maxxing/wallet-core/approvals";
import { isSigningMethod, signWithConsent, type SigningMethod } from "./consent";

type Handler = (params: any) => unknown;
const setVisible = (visible: boolean) => announce({ protocol: WALLET_PROTOCOL, v: WALLET_PROTOCOL_VERSION, event: "visible", visible });

const withConsent = (method: SigningMethod, params: unknown, origin: string) =>
  signWithConsent(method, params, origin, view => openApproval(view, setVisible), shown => handlers[method]!(shown));

/**
 * Every call an app may make. Anything not listed is refused. Creating, unlocking, backing up and restoring
 * happen only on the frame's own screens ("ui.open"), so a PIN or recovery phrase never passes through the app.
 * The signing methods below run only through withConsent.
 */
const handlers: Record<string, Handler> = {
  "state": () => walletState(),
  "session.restore": () => restoreOnce(),
  "ui.open": p => {
    const screen = String(p?.screen ?? "") as WalletScreen;
    if (!SCREENS.includes(screen)) throw new Error("WALLET_SCREEN_UNKNOWN");
    return openScreen(screen, setVisible);
  },
  "accounts.select": p => { closeScreens(); return vault.selectPlatformWallet(String(p?.id ?? "")); },
  "accounts.rename": p => vault.renamePlatformWallet(String(p?.id ?? ""), String(p?.label ?? "")),
  "wallet.signOut": () => { closeScreens(); return vault.signOutPlatformWallet(); },
  "wallet.cancel": () => { closeScreens(); return vault.cancelPlatformWalletOperation(); },
  // Partner apps the active wallet is connected to (through the wallet window), for MAXXING's settings.
  "apps.list": () => { const id = vault.activePlatformWalletId(); return id ? approvals.listApprovals(id) : []; },
  "apps.revoke": p => { const id = vault.activePlatformWalletId(); return id ? approvals.revoke(id, String(p?.appId ?? "")) : false; },
  "evm.address": () => signing.evmAddress(),
  "evm.signMessage": p => signing.evmSignMessage(p),
  "evm.signTypedData": p => signing.evmSignTypedData(p),
  "evm.signTransaction": p => signing.evmSignTransaction(p),
  "evm.signAuthorization": p => signing.evmSignAuthorization(p),
  "solana.signBytes": p => signing.solanaSignBytes(p),
};

let parentOrigin: string | null = null;
let restored: Promise<boolean> | null = null;
/** Reopens a wallet that is still signed in on this device; once per frame load, before anything signs. */
function restoreOnce() {
  restored ??= vault.restoreDeviceSession().catch(() => false);
  return restored;
}
let lastState = "";

function post(message: WalletResponse | WalletEvent, origin: string) {
  window.parent.postMessage(message, origin);
}
function announce(message: WalletEvent) { if (parentOrigin) post(message, parentOrigin); }

/** Pushes the public state to the app whenever it changes. */
function publishState() {
  if (!parentOrigin) return;
  const state = walletState();
  const serialized = JSON.stringify(state);
  if (serialized === lastState) return;
  lastState = serialized;
  post({ protocol: WALLET_PROTOCOL, v: WALLET_PROTOCOL_VERSION, event: "state", state }, parentOrigin);
}

window.addEventListener("message", async event => {
  // Only the window that embeds this frame, and only from a registered website.
  if (event.source !== window.parent || window.parent === window) return;
  const app = appForOrigin(event.origin);
  if (!app) return;
  const request = event.data as WalletRequest;
  if (!request || request.protocol !== WALLET_PROTOCOL || typeof request.id !== "string" || typeof request.method !== "string") return;
  const reply = (body: { ok: true; result: unknown } | { ok: false; error: { message: string; code?: number } }) =>
    post({ protocol: WALLET_PROTOCOL, v: WALLET_PROTOCOL_VERSION, id: request.id, ...body } as WalletResponse, event.origin);
  if (request.v !== WALLET_PROTOCOL_VERSION) return reply({ ok: false, error: { message: "WALLET_PROTOCOL_UNSUPPORTED" } });
  if (request.app !== app.id) return reply({ ok: false, error: { message: "WALLET_APP_MISMATCH" } });
  const handler = Object.prototype.hasOwnProperty.call(handlers, request.method) ? handlers[request.method] : undefined;
  if (!handler) return reply({ ok: false, error: { message: "WALLET_METHOD_UNSUPPORTED" } });
  parentOrigin = event.origin;
  try {
    const result = await (isSigningMethod(request.method) ? withConsent(request.method, request.params, event.origin) : handler(request.params));
    reply({ ok: true, result });
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    reply({ ok: false, error: { message: error instanceof Error ? error.message : String(error), ...(typeof code === "number" ? { code } : {}) } });
  } finally {
    publishState();
  }
});

// Changes from other tabs, sign-ins and sign-outs all surface as wallet events inside the frame.
window.addEventListener("maxxing:wallet", publishState);
window.addEventListener("storage", () => publishState());

/** Data the password and passkey wallet kept here before the PIN wallet replaced it. */
function removeRetiredStorage() {
  try {
    for (const key of ["maxxing.platformWallet.accounts.v2", "maxxing.platformWallet.vault", "maxxing.platformWallet.public", "maxxing.platformWallet.lockRevision"]) localStorage.removeItem(key);
    for (let i = localStorage.length - 1; i >= 0; i--) { const key = localStorage.key(i); if (key?.startsWith("maxxing.deviceUnlock.v1.")) localStorage.removeItem(key); }
    sessionStorage.removeItem("maxxing.platformWallet.reloadSession");
    indexedDB.deleteDatabase("maxxing-wallet-reload-v2");
    indexedDB.deleteDatabase("maxxing-wallet-reload-v1");
  } catch { /* storage blocked */ }
}

function start() {
  removeRetiredStorage();
  vault.startWalletProtection();
  // The frame does not know its parent's origin until the first request; announce readiness to any registered parent.
  const referrer = (() => { try { return document.referrer ? new URL(document.referrer).origin : null; } catch { return null; } })();
  const ancestors = (location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins;
  const parent = ancestors?.length ? ancestors[0] : referrer;
  if (parent && appForOrigin(parent)) post({ protocol: WALLET_PROTOCOL, v: WALLET_PROTOCOL_VERSION, event: "ready" }, parent);
}
start();
