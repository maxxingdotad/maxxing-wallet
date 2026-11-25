import { WALLET_ERROR_CODES, WALLET_PROTOCOL, WALLET_PROTOCOL_VERSION, WINDOW_METHODS, type WalletConnection, type WalletError, type WalletRequest, type WindowMethod } from "../protocol";
import { API_URL, checkPartnerApp, loadPartnerApp, reportUsage, type PartnerApp } from "../registry";
import { loadRuntimeConfig, websiteUrl } from "./runtime-config";
import * as vault from "@maxxing/wallet-core/vault";
import * as signing from "@maxxing/wallet-core/signing";
import { approvalFor, approve, listApprovals, revoke, touch } from "@maxxing/wallet-core/approvals";
import { isSolanaTransactionMessage, signSolanaTransaction } from "@maxxing/wallet-core/solana-tx";
import { openScreen } from "../ui/screens";
import { bytesForDisplay, checkedTransaction, messageForDisplay, networkKnown, networkName, short, solanaSummary, transactionSummary, typedDataSummary, type Row } from "@maxxing/wallet-core/review";
import { loginMethods, openAppSession, signInWithProvider, type LoginMethod, type Redeemed } from "./social";
import { appHeader as header, h, securedFooter, signInView, type Child } from "./signin-view";
import { applyLook, currentLook, lookFor } from "./look";
import { checkSignIn, fundsCheck, nativeBalance, previewTransaction, untilText, type SignInCheck } from "./insight";
import { formatUnits } from "viem";
import { getChain } from "@maxxing/wallet-core/chains";

/**
 * The wallet window. Partner websites open it to connect and to ask for signatures; the user sees every request here,
 * on the wallet's own site, and nothing is signed without their tap. Opened on its own (apps.html) it lists connected apps.
 */
vault.setWalletPublishing(false);
vault.startWalletProtection();

const root = document.getElementById("app")!;

function show(...children: Child[]) {
  root.replaceChildren(...children.filter(Boolean) as Node[]);
  // Every screen ends with "Secured by MAXXING", whatever the app's look.
  const page = root.querySelector("main");
  if (page && !page.querySelector("footer.secured") && !page.classList.contains("center")) page.append(securedFooter());
}

/** The app at the top: sign-in screens use the app's chosen layout; approvals always use the card with the website. */
const appHeader = (app: PartnerApp, origin: string, inReview: boolean, styled = false) => header(app, origin, inReview, styled ? currentLook().logo : "card");

function walletLine() {
  const accounts = vault.savedPlatformWallets(), active = accounts.find(a => a.id === vault.activePlatformWalletId());
  return active ? h("p", { className: "wallet" }, h("span", {}, active.label), h("code", {}, short(active.evm))) : null;
}

function rowsTable(rows: Row[]) {
  return rows.length ? h("dl", { className: "rows" }, ...rows.flatMap(([label, value]) => [h("dt", {}, label), h("dd", {}, value)])) : null;
}

function message(text: string, kind: "info" | "error" = "info") { return h("p", { className: kind === "error" ? "error" : "note" }, text); }

/** Friendly words for errors the wallet raises. */
function plainError(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  if (code === "WALLET_LOCKED") return "Unlock your wallet to continue.";
  if (code.startsWith("Verify your recovery") || code.startsWith("Upgrade this wallet")) return `${code} Open MAXXING to finish.`;
  if (code === "WALLET_RESTORED_IS_DIFFERENT") return "That recovery phrase opens a different wallet than the one this account uses.";
  if (code === "SIGN_IN_WRONG_SITE") return "This sign-in is for a different website than the one asking. Signing it could let that site sign in as you, so the wallet won't sign it.";
  if (code === "SIGN_IN_WRONG_ACCOUNT") return "This sign-in names a different wallet address. Go back to the site and connect again.";
  if (code === "SIGN_IN_EXPIRED") return "This sign-in request has expired. Go back to the site and try again.";
  if (code === "SIGN_IN_NOT_YET_VALID") return "This sign-in request isn't valid yet. Check your device's clock and try again.";
  if (code === "INVALID_TRANSACTION" || code === "INVALID_SIGN_REQUEST" || code === "EIP712_PAYLOAD_INVALID" || code.startsWith("SOLANA_")) return "This request can't be signed.";
  return "Something went wrong. Try again.";
}

// ── Connected apps page ─────────────────────────────────────────────────────────
function renderAppsPage() {
  const activeId = vault.activePlatformWalletId();
  if (!activeId) {
    const open = h("a", { className: "button", href: websiteUrl(), target: "_blank", rel: "noopener" }, "Open MAXXING");
    // Admin's website address: fetched only here, never in a connect or signing window.
    void loadRuntimeConfig(API_URL).then(() => { open.href = websiteUrl(); });
    show(h("main", {}, h("h1", {}, "Connected apps"), message("There's no MAXXING wallet on this device."), open));
    return;
  }
  const approvals = listApprovals(activeId);
  show(h("main", {},
    h("h1", {}, "Connected apps"),
    walletLine(),
    approvals.length ? h("ul", { className: "apps" }, ...approvals.map(entry => h("li", {},
      h("div", {}, h("strong", {}, entry.name), h("span", { className: "origin" }, entry.origins.map(o => o.replace(/^https:\/\//, "")).join(", ")),
        h("small", {}, `Connected ${new Date(entry.approvedAt).toLocaleDateString()}`)),
      h("button", { className: "secondary", onClick: () => { revoke(activeId, entry.appId); renderAppsPage(); } }, "Remove"))))
      : message("No apps connected."),
    approvals.length ? message("Removing an app stops it from asking this wallet for anything until you connect it again.") : null));
}

// ── Requests from a partner website ─────────────────────────────────────────────
const appId = new URLSearchParams(location.search).get("app") ?? "";
let partnerOrigin: string | null = null;
let busy = false;
const queue: { request: WalletRequest; origin: string }[] = [];
let current: WalletRequest | null = null;
let closeTimer = 0;

function respond(request: WalletRequest, body: { ok: true; result: unknown } | { ok: false; error: WalletError }) {
  if (!partnerOrigin || !window.opener) return;
  (window.opener as Window).postMessage({ protocol: WALLET_PROTOCOL, v: WALLET_PROTOCOL_VERSION, id: request.id, ...body }, partnerOrigin);
}
const reject = (request: WalletRequest, code: number, message: string) => respond(request, { ok: false, error: { code, message } });
/** What a partner site is told when something fails: a fixed code, never internal error text. */
const errorCode = (error: unknown, fallback: string) => {
  const text = error instanceof Error ? error.message : String(error);
  return /^[A-Z][A-Z0-9_]{2,63}$/.test(text) ? text : fallback;
};

/** How long a new screen's action buttons stay off, so a double-click or a held Enter meant for the last screen can't press them. */
const ARM_DELAY_MS = 700;
/**
 * Keeps `buttons` off for a moment after they appear, and again whenever the window comes back into view or focus (a site can move or
 * cover the window), so every approval is a deliberate click on what is shown.
 */
function armSlowly(...buttons: HTMLButtonElement[]) {
  let timer = 0;
  const hold = () => {
    for (const button of buttons) button.disabled = true;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => { for (const button of buttons) if (button.isConnected) button.disabled = false; }, ARM_DELAY_MS);
  };
  hold();
  const onVisible = () => { if (document.visibilityState === "visible") hold(); };
  window.addEventListener("focus", hold);
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    window.clearTimeout(timer);
    window.removeEventListener("focus", hold);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

function finish() {
  current = null;
  busy = false;
  if (queue.length) { void next(); return; }
  show(h("main", { className: "center" }, h("p", { className: "done" }, "Done")));
  // The app may send another request right away (approve, then swap): stay open a moment for it.
  closeTimer = window.setTimeout(() => window.close(), 400);
}

window.addEventListener("message", event => {
  if (!window.opener || event.source !== window.opener) return;
  const request = event.data as WalletRequest;
  if (!request || request.protocol !== WALLET_PROTOCOL || typeof request.id !== "string" || typeof request.method !== "string") return;
  // One window serves one website for its whole life.
  if (partnerOrigin && event.origin !== partnerOrigin) return;
  partnerOrigin ??= event.origin;
  if (request.v !== WALLET_PROTOCOL_VERSION) return reject(request, WALLET_ERROR_CODES.unsupported, "WALLET_PROTOCOL_UNSUPPORTED");
  if (request.app !== appId) return reject(request, WALLET_ERROR_CODES.unauthorized, "WALLET_APP_MISMATCH");
  if (!(WINDOW_METHODS as readonly string[]).includes(request.method)) return reject(request, WALLET_ERROR_CODES.unsupported, "WALLET_METHOD_UNSUPPORTED");
  window.clearTimeout(closeTimer);
  queue.push({ request, origin: event.origin });
  if (!busy) void next();
});

window.addEventListener("pagehide", () => {
  for (const item of [current, ...queue.map(q => q.request)]) if (item) reject(item, WALLET_ERROR_CODES.userRejected, "User closed the wallet.");
});

async function next() {
  const item = queue.shift();
  if (!item) return;
  busy = true;
  current = item.request;
  const { request, origin } = item;
  let app: PartnerApp | null;
  try { app = await loadPartnerApp(appId); }
  catch {
    show(h("main", {}, h("h1", {}, "Can't reach MAXXING"), message("Check your connection and try again.", "error")));
    reject(request, WALLET_ERROR_CODES.internal, "WALLET_APP_LOOKUP_FAILED");
    busy = false; current = null;
    return;
  }
  const check = checkPartnerApp(app, origin);
  if (!check.ok) {
    const words = { unknown: "This app isn't registered with MAXXING.", suspended: "MAXXING has blocked this app.", in_review: "This app is waiting for review by MAXXING. Until it's approved it works only on localhost (test mode).", wrong_site: "This website isn't allowed to use this app." }[check.reason];
    show(h("main", {}, h("h1", {}, "Can't connect"), message(words, "error"), h("p", { className: "origin" }, origin)));
    reject(request, WALLET_ERROR_CODES.unauthorized, `WALLET_APP_${check.reason.toUpperCase()}`);
    busy = false; current = null;
    return;
  }
  try { await handle(request, check.app, origin, check.inReview); }
  catch (error) {
    reject(request, WALLET_ERROR_CODES.internal, errorCode(error, "WALLET_REQUEST_FAILED"));
    finish();
  }
}

function activeWallet() {
  const id = vault.activePlatformWalletId();
  const wallet = vault.savedPlatformWallets().find(a => a.id === id);
  return wallet && id ? { id, wallet } : null;
}

let codeLook: unknown = undefined;

async function handle(request: WalletRequest, app: PartnerApp, origin: string, inReview: boolean) {
  const active = activeWallet();
  // The app's look (dashboard), with what its code sent on connect on top; colours carry to every screen.
  if (request.method === "connect") codeLook = (request.params as { appearance?: unknown } | undefined)?.appearance ?? codeLook;
  const { methods, appearance } = await loginMethods(app.id);
  applyLook(lookFor(appearance, codeLook));
  // Not connected yet and the app offers social sign-in: that comes first, with the MAXXING wallet as the other choice.
  if (!(active && approvalFor(active.id, app.id, origin)) && methods.length) { await signInFlow(request, app, origin, inReview, methods); return; }
  await handleWithWallet(request, app, origin, inReview);
}

/** What a connected app gets back: the addresses, and when the wallet is open, a signed identity token for its server. */
async function connectResult(app: PartnerApp, connection: WalletConnection, signedIn?: Redeemed | null, wantIdentity = false) {
  // signIn() asks for an identity: open the wallet for it. A plain connect never asks for the PIN.
  if (!vault.platformWalletUnlocked() && wantIdentity) await walletScreen("unlock");
  if (!vault.platformWalletUnlocked()) return connection;
  try {
    const session = await openAppSession(app, connection, signedIn);
    return { ...connection, user: session.user, identityToken: session.identityToken };
  } catch { return connection; }
}

const wantsIdentity = (request: WalletRequest) => (request.params as { identity?: unknown } | undefined)?.identity === true;

const LOGIN_WORDS: Record<string, string> = {
  LOGIN_CANCELLED: "Sign-in cancelled.",
  LOGIN_POPUP_BLOCKED: "Your browser blocked the sign-in window. Allow pop-ups for wallet.maxxing.ad and try again.",
  LOGIN_TIMED_OUT: "Sign-in took too long. Try again.",
  LOGIN_METHOD_NOT_AVAILABLE: "That sign-in isn't available for this app right now.",
  LOGIN_TICKET_INVALID: "Sign-in expired. Try again.",
};

/** "Continue with Google / X / …" for an app, then one MAXXING wallet for that account. */
function signInFlow(request: WalletRequest, app: PartnerApp, origin: string, inReview: boolean, methods: LoginMethod[]): Promise<void> {
  return new Promise<void>(resolve => {
    const cancelRequest = () => { reject(request, WALLET_ERROR_CODES.userRejected, "User rejected the request."); finish(); resolve(); };
    const status = h("p", { className: "error", role: "alert" });
    const choose = (error = "") => {
      status.textContent = error;
      show(signInView({
        app, origin, inReview, methods, look: currentLook(), status,
        wallet: activeWallet() ? { address: activeWallet()!.wallet.evm } : null,
        on: {
          method: method => void go(method),
          wallet: () => void handleWithWallet(request, app, origin, inReview).then(resolve),
          create: () => void walletScreen("create").then(() => handleWithWallet(request, app, origin, inReview)).then(resolve),
          restore: () => void walletScreen("restore").then(() => handleWithWallet(request, app, origin, inReview)).then(resolve),
          cancel: cancelRequest,
        },
      }));
    };
    const go = async (method: LoginMethod) => {
      const abort = new AbortController();
      show(h("main", { className: "center" }, appHeader(app, origin, inReview, true),
        h("p", {}, `Continue in the ${method.label} window…`),
        h("button", { type: "button", className: "secondary", onClick: () => abort.abort() }, "Cancel")));
      let signedIn: Redeemed;
      try { signedIn = await signInWithProvider(app.id, method.provider, abort.signal); }
      catch (error) { return choose(LOGIN_WORDS[(error as Error).message] ?? "Sign-in didn't finish. Try again."); }
      try {
        const wallet = await walletForSignIn(app, origin, inReview, signedIn);
        if (!wallet) return choose();
        const connection: WalletConnection = { evm: wallet.evm as `0x${string}`, solana: wallet.solana };
        approve(wallet.id, app, origin);
        reportUsage(app, "connect");
        const result = await connectResult(app, connection, signedIn);
        if (request.method === "connect") { respond(request, { ok: true, result }); finish(); }
        else await handleWithWallet(request, app, origin, inReview);
        resolve();
      } catch (error) { choose(plainError(error)); }
    };
    choose();
  });
}

/**
 * The wallet a social sign-in uses on this device: the one already linked to that account (restored with its phrase if it
 * isn't here), or for a first sign-in, the wallet here or a new one. Returns it open, or null if the person backed out.
 */
async function walletForSignIn(app: PartnerApp, origin: string, inReview: boolean, signedIn: Redeemed) {
  const who = `${signedIn.identity.label}${signedIn.identity.username ? ` @${signedIn.identity.username}` : ""}`;
  const linked = signedIn.linkedWallet;
  const find = (evm: string) => vault.savedPlatformWallets().find(w => w.evm.toLowerCase() === evm.toLowerCase());
  if (linked) {
    let here = find(linked.evm);
    if (!here) {
      const restore = await new Promise<boolean>(answer => show(h("main", {}, appHeader(app, origin, inReview, true),
        h("h1", {}, "Restore your wallet"),
        message(`${who} uses wallet ${short(linked.evm)} with ${app.name}. It isn't on this device yet: restore it with its recovery phrase.`),
        h("div", { className: "actions" },
          h("button", { className: "secondary", onClick: () => answer(false) }, "Back"),
          h("button", { onClick: () => answer(true) }, "Restore")))));
      if (!restore || !(await walletScreen("restore"))) return null;
      here = find(linked.evm);
      if (!here) throw new Error("WALLET_RESTORED_IS_DIFFERENT");
    }
    if (vault.activePlatformWalletId() !== here.id) await vault.selectPlatformWallet(here.id);
  } else {
    const active = activeWallet();
    if (active) {
      const choice = await new Promise<"use" | "new" | "back">(answer => show(h("main", {}, appHeader(app, origin, inReview, true),
        h("h1", {}, `Signed in as ${who}`),
        message(`Use your wallet on this device with ${app.name}, or make a new one for this account.`),
        h("p", { className: "wallet" }, h("span", {}, active.wallet.label), h("code", {}, short(active.wallet.evm))),
        h("div", { className: "actions" },
          h("button", { className: "secondary", onClick: () => answer("new") }, "New wallet"),
          h("button", { onClick: () => answer("use") }, "Use this wallet")),
        h("button", { className: "link", onClick: () => answer("back") }, "Back"))));
      if (choice === "back") return null;
      if (choice === "new" && !(await walletScreen("create"))) return null;
    } else if (!(await walletScreen("create"))) return null;
  }
  if (!vault.platformWalletUnlocked() && !(await walletScreen("unlock"))) return null;
  const now = activeWallet();
  return now ? { id: now.id, evm: now.wallet.evm, solana: now.wallet.solana } : null;
}

async function handleWithWallet(request: WalletRequest, app: PartnerApp, origin: string, inReview: boolean) {
  const active = activeWallet();
  if (!active) {
    show(h("main", {}, appHeader(app, origin, inReview, true),
      h("h1", {}, "No wallet on this device"),
      message("Create a MAXXING wallet here, or restore one with its recovery phrase."),
      h("div", { className: "actions" },
        h("button", { className: "secondary", onClick: () => { reject(request, WALLET_ERROR_CODES.userRejected, "User rejected the request."); finish(); } }, "Cancel"),
        h("button", { onClick: () => void walletScreen("create").then(() => handleWithWallet(request, app, origin, inReview)) }, "Create wallet")),
      h("button", { className: "link", onClick: () => void walletScreen("restore").then(() => handleWithWallet(request, app, origin, inReview)) }, "Restore a wallet")));
    return;
  }
  const connection: WalletConnection = { evm: active.wallet.evm, solana: active.wallet.solana };
  const connected = approvalFor(active.id, app.id, origin);
  if (!connected) {
    const approved = await askToConnect(app, origin, inReview, request.method === "connect");
    if (!approved) { reject(request, WALLET_ERROR_CODES.userRejected, "User rejected the request."); finish(); return; }
    approve(active.id, app, origin);
    reportUsage(app, "connect");
    if (request.method === "connect") { respond(request, { ok: true, result: await connectResult(app, connection, null, wantsIdentity(request)) }); finish(); return; }
  }
  if (request.method === "connect") { touch(active.id, app.id); respond(request, { ok: true, result: await connectResult(app, connection, null, wantsIdentity(request)) }); finish(); return; }

  // A request made for another wallet (the user switched since connecting) is refused; the app reconnects.
  const params = (request.params ?? {}) as { address?: string };
  const address = request.method.startsWith("solana.") ? connection.solana : connection.evm;
  if (typeof params.address !== "string" || params.address.toLowerCase() !== address.toLowerCase()) {
    reject(request, WALLET_ERROR_CODES.unauthorized, "WALLET_CHANGED");
    finish();
    return;
  }
  await confirmAndSign(request.method as Exclude<WindowMethod, "connect">, request, app, origin, inReview, connection);
}

/** The wallet's own screens (create, restore, PIN unlock), shown over the window while they are open. */
async function walletScreen(screen: "create" | "restore" | "unlock") {
  const page = root.firstElementChild as HTMLElement | null;
  const result = await openScreen(screen, visible => { if (page) page.hidden = visible; });
  if (page) page.hidden = false;
  return result.done;
}

function askToConnect(app: PartnerApp, origin: string, inReview: boolean, onlyConnect: boolean): Promise<boolean> {
  return new Promise(resolve => {
    const connect = h("button", {}, "Connect") as HTMLButtonElement;
    const stop = armSlowly(connect);
    connect.addEventListener("click", () => { stop(); resolve(true); });
    show(h("main", {},
      appHeader(app, origin, inReview),
      h("h1", {}, `${app.name} wants to connect`),
      walletLine(),
      h("ul", { className: "points" },
        h("li", {}, "It can see your wallet addresses."),
        h("li", {}, "It can ask you to sign. You'll see and confirm each request here."),
        h("li", {}, "It can't move anything without your OK.")),
      !onlyConnect && message("After connecting you'll see what it wants you to sign."),
      h("div", { className: "actions" },
        h("button", { className: "secondary", onClick: () => { stop(); resolve(false); } }, "Cancel"),
        connect),
      h("p", { className: "fine" }, "You can remove connected apps any time at wallet.maxxing.ad/apps.html.")));
  });
}

/** Decoded token actions: what happens, in words, with a warning under any that hands something over. */
function actionLines(actions: { text: string; warning: string | null }[]): Child[] {
  return actions.flatMap(action => [h("p", { className: "action" }, action.text), action.warning ? h("p", { className: "warn" }, action.warning) : null]);
}

type Prepared = { title: string; body: Child[]; sign: () => Promise<unknown>; confirm: string };
const UNKNOWN_NETWORK = "MAXXING doesn't list this network, so it can't check this request. Only continue if you trust this website.";

/** A Sign-In with Ethereum (or Solana) message, shown as a sign-in to the site it names. */
function signInPrepared(check: Extract<SignInCheck, { ok: true }>, text: string, sign: () => Promise<unknown>): Prepared {
  const m = check.message;
  return {
    title: `Sign in to ${m.domain}`, confirm: "Sign in",
    body: [
      rowsTable([
        ["Website", m.domain],
        ["Account", short(m.address)],
        ...(m.chainId !== null ? [["Network", networkName(m.chainId)] as Row] : []),
        ...(m.expirationTime ? [["Expires", untilText(m.expirationTime)] as Row] : []),
      ]),
      m.statement ? h("p", { className: "statement" }, m.statement) : null,
      ...check.warnings.map(w => h("p", { className: "warn" }, w)),
      message("Signing in proves you own this wallet. It's free and doesn't send anything."),
      h("details", {}, h("summary", {}, "Full message"), h("pre", { className: "message" }, text)),
    ],
    sign,
  };
}

/** Fills `box` with the transaction preview and a balance check once the network answers. Signing never waits for it. */
async function loadInsight(box: HTMLElement, tx: { chainId: number; to?: string | null; value?: bigint; data?: string | null; gas?: bigint; maxFeePerGas?: bigint; gasPrice?: bigint }, from: string) {
  const symbol = getChain(tx.chainId)?.nativeSymbol ?? "ETH";
  const price = tx.maxFeePerGas ?? tx.gasPrice ?? null;
  const maxFee = tx.gas !== undefined && price !== null ? tx.gas * price : null;
  const [preview, balance] = await Promise.allSettled([previewTransaction(tx, from), nativeBalance(tx.chainId, from)]);
  const parts: Child[] = [];
  if (preview.status === "fulfilled" && preview.value.kind === "changes") {
    const changes = preview.value.changes;
    parts.push(h("p", { className: "insight-title" }, "Estimated changes"));
    parts.push(changes.length
      ? h("ul", { className: "changes" }, ...changes.map(c => h("li", { className: c.direction }, h("span", {}, c.direction === "out" ? "You send" : "You get"), h("b", {}, `${c.direction === "out" ? "−" : "+"}${c.amount} ${c.symbol}`))))
      : h("p", { className: "note" }, "Nothing moves in or out of your wallet, apart from the network fee."));
  } else if (preview.status === "fulfilled" && preview.value.kind === "fails") {
    parts.push(h("p", { className: "warn" }, "This transaction is likely to fail if you confirm it now. You'd still pay the network fee."));
  } else {
    parts.push(h("p", { className: "note" }, "A preview isn't available on this network right now. Check the details below."));
  }
  if (balance.status === "fulfilled") {
    const funds = fundsCheck(balance.value, tx.value ?? 0n, maxFee);
    if (!funds.enough) parts.push(h("p", { className: "warn" }, `Not enough ${symbol}: you have ${fmt(funds.balance)} and this can cost up to ${fmt(funds.needs)} ${symbol}.`));
    else parts.push(h("p", { className: "fine left" }, `Your balance: ${fmt(funds.balance)} ${symbol}`));
  }
  box.replaceChildren(...parts.filter(Boolean) as Node[]);
}
function fmt(value: bigint) {
  const [whole, fraction = ""] = formatUnits(value, 18).split(".");
  const cut = fraction.slice(0, 6).replace(/0+$/, "");
  return cut ? `${whole}.${cut}` : whole!;
}

function prepare(method: Exclude<WindowMethod, "connect">, params: Record<string, unknown>, app: PartnerApp, connection: WalletConnection, origin: string): Prepared {
  switch (method) {
    case "evm.signMessage": {
      const shown = messageForDisplay(params.message);
      const signIn = shown.raw ? null : checkSignIn(shown.text, origin, connection.evm);
      if (signIn && !signIn.ok) throw new Error(signIn.code);
      if (signIn) return signInPrepared(signIn, shown.text, () => signing.evmSignMessage({ message: params.message as string }));
      return {
        title: `${app.name} asks you to sign a message`, confirm: "Sign",
        body: [h("pre", { className: shown.raw ? "message raw" : "message" }, shown.text), message("Signing a message is free and doesn't send anything.")],
        sign: () => signing.evmSignMessage({ message: params.message as string }),
      };
    }
    case "evm.signTypedData": {
      const summary = typedDataSummary(params.typedData);
      return {
        title: `${app.name} asks you to sign`, confirm: "Sign",
        body: [
          summary.network && !networkKnown((params.typedData as { domain?: { chainId?: unknown } }).domain?.chainId) ? h("p", { className: "warn" }, UNKNOWN_NETWORK) : null,
          summary.spending ? h("p", { className: "warn" }, `This lets ${summary.app ?? "someone"} use your tokens later. Only sign if you trust ${app.name}.`) : null,
          rowsTable([["Type", summary.kind], ...(summary.app ? [["For", summary.app] as Row] : []), ...(summary.network ? [["Network", summary.network] as Row] : []), ...(summary.contract ? [["Contract", short(summary.contract)] as Row] : [])]),
          h("details", {}, h("summary", {}, "Details"), rowsTable(summary.rows)),
        ],
        sign: () => signing.evmSignTypedData(params.typedData as never),
      };
    }
    case "evm.signTransaction": {
      // One checked object for both: the screen shows it and the wallet signs it.
      const transaction = checkedTransaction(params.transaction);
      const summary = transactionSummary(transaction);
      const insight = h("div", { className: "insight", "aria-live": "polite" }, h("p", { className: "note" }, "Checking what this transaction does…"));
      void loadInsight(insight, transaction as never, connection.evm).catch(() => insight.replaceChildren());
      return {
        title: `${app.name} wants to send a transaction`, confirm: "Confirm",
        body: [
          networkKnown(transaction.chainId) ? null : h("p", { className: "warn" }, UNKNOWN_NETWORK),
          insight,
          rowsTable([["Network", summary.network], ["To", summary.to ? short(summary.to) : "New contract"], ["Amount", summary.amount], ...(summary.maxFee ? [["Network fee, at most", summary.maxFee] as Row] : [])]),
          ...actionLines(summary.tokenCall ? [summary.tokenCall] : []),
          summary.callsContract && !summary.tokenCall ? message("This also runs app code on the network.") : null,
          summary.rows.length ? h("details", {}, h("summary", {}, "Details"), rowsTable(summary.rows)) : null,
        ],
        sign: () => signing.evmSignTransaction({ transaction: transaction as never }),
      };
    }
    case "solana.signMessage": {
      const bytes = params.bytes;
      if (!(bytes instanceof Uint8Array) || !bytes.length || isSolanaTransactionMessage(bytes)) throw new Error("INVALID_SIGN_REQUEST");
      const shown = bytesForDisplay(bytes);
      const signIn = shown.raw ? null : checkSignIn(shown.text, origin, connection.solana);
      if (signIn && !signIn.ok) throw new Error(signIn.code);
      if (signIn) return signInPrepared(signIn, shown.text, () => signing.solanaSignBytes({ bytes }));
      return {
        title: `${app.name} asks you to sign a message`, confirm: "Sign",
        body: [h("pre", { className: shown.raw ? "message raw" : "message" }, shown.text), message("Signing a message is free and doesn't send anything.")],
        sign: () => signing.solanaSignBytes({ bytes }),
      };
    }
    case "solana.signTransaction": {
      const summary = solanaSummary(params.bytes, connection.solana);
      return {
        title: `${app.name} wants to send a transaction`, confirm: "Confirm",
        body: [...actionLines(summary.actions), rowsTable([["Network", "Solana"], ...summary.rows]), summary.usesLookupTables ? message("Some accounts in this request are listed outside it.") : null],
        sign: () => signSolanaTransaction(params.bytes as Uint8Array, connection.solana, message => signing.solanaSignBytes({ bytes: message })),
      };
    }
  }
}

async function confirmAndSign(method: Exclude<WindowMethod, "connect">, request: WalletRequest, app: PartnerApp, origin: string, inReview: boolean, connection: WalletConnection) {
  let prepared: Prepared;
  try { prepared = prepare(method, (request.params ?? {}) as Record<string, unknown>, app, connection, origin); }
  catch (error) {
    show(h("main", {}, appHeader(app, origin, inReview), h("h1", {}, "Can't sign this"), message(plainError(error), "error")));
    reject(request, WALLET_ERROR_CODES.invalidParams, errorCode(error, "INVALID_SIGN_REQUEST"));
    busy = false; current = null;
    window.setTimeout(() => { if (!queue.length) window.close(); else void next(); }, 2500);
    return;
  }
  const status = h("p", { className: "error", role: "alert" });
  const cancel = h("button", { type: "button", className: "secondary" }, "Cancel");
  const submit = h("button", { type: "submit" }, prepared.confirm) as HTMLButtonElement;
  // Not focused and briefly off: the click or Enter that answered the last request can't land on this one.
  const stopArming = armSlowly(submit);
  cancel.addEventListener("click", () => { stopArming(); reject(request, WALLET_ERROR_CODES.userRejected, "User rejected the request."); finish(); });
  const form = h("form", { className: "confirm" },
    vault.platformWalletUnlocked() ? null : message("You'll enter your PIN to sign."),
    status,
    h("div", { className: "actions" }, cancel, submit));
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (submit.disabled) return;
    stopArming();
    submit.disabled = cancel.disabled = true;
    status.textContent = "";
    try {
      // A wallet signed out on this device opens with its PIN, on the wallet's own PIN screen.
      if (!vault.platformWalletUnlocked() && !(await walletScreen("unlock"))) { submit.disabled = cancel.disabled = false; return; }
      const result = await prepared.sign();
      touch(activeWallet()!.id, app.id);
      reportUsage(app, "sign");
      respond(request, { ok: true, result });
      finish();
    } catch (error) {
      status.textContent = plainError(error);
      submit.disabled = cancel.disabled = false;
    }
  });
  show(h("main", {}, appHeader(app, origin, inReview), h("h1", {}, prepared.title), walletLine(), ...prepared.body, form));
}

async function start() {
  if (location.pathname.endsWith("/apps.html")) { renderAppsPage(); window.addEventListener("maxxing:wallet", renderAppsPage); return; }
  if (!window.opener) {
    show(h("main", {}, h("h1", {}, "MAXXING Wallet"), message("This window opens from apps that use your MAXXING wallet."), h("a", { className: "button", href: "/apps.html" }, "See connected apps")));
    return;
  }
  show(h("main", { className: "center" }, h("p", {}, "Loading…")));
  // A wallet still signed in on this device opens without the PIN, as it does on MAXXING.
  await vault.restoreDeviceSession().catch(() => false);
  // Nothing secret here: the window only says it is ready to hear from whoever opened it.
  (window.opener as Window).postMessage({ protocol: WALLET_PROTOCOL, v: WALLET_PROTOCOL_VERSION, event: "ready" }, "*");
}
void start();
