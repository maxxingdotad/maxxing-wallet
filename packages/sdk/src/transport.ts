import { ERROR_CODES, ProviderRpcError, WALLET_PROTOCOL, WALLET_PROTOCOL_VERSION, type WalletResponse, type WindowMethod } from "./protocol";
import { createWaitingDialog, type WaitingDialog } from "./dialog";
import type { WalletTheme } from "./theme";
import type { WindowAppearanceInput } from "./appearance";

/** The parts of `window` the transport uses, so tests can run without a browser. */
export type HostWindow = Pick<Window, "open" | "addEventListener" | "removeEventListener" | "setInterval" | "clearInterval" | "setTimeout"> & { screenX?: number; screenY?: number; outerWidth?: number; outerHeight?: number };
type Popup = Pick<Window, "postMessage" | "close" | "focus"> & { closed: boolean };

type Pending = { id: string; method: WindowMethod; params: unknown; resolve: (value: unknown) => void; reject: (error: Error) => void; sentAt: number | null; retried: boolean };

const WIDTH = 400, HEIGHT = 640;
/** A request sent in the moment the window was closing after its last answer is sent again in a new window. */
const CLOSE_RACE_MS = 1000;

/**
 * Talks to the MAXXING wallet window on wallet.maxxing.ad. The wallet keeps its keys on its own site; every request
 * opens (or reuses) its window, where the user sees and confirms it. While a request waits, a small dialog on this
 * page says so, and offers a button when the browser blocked the window.
 */
export class WalletWindow {
  readonly walletOrigin: string;
  private readonly url: string;
  private popup: Popup | null = null;
  private ready = false;
  private pending: Pending[] = [];
  private sequence = 0;
  private poll = 0;
  private lastAnswerAt = 0;
  private dialog: WaitingDialog | null = null;
  private readonly host: HostWindow;
  private readonly onMessage = (event: MessageEvent) => this.receive(event);

  constructor(private readonly options: { appId: string; walletUrl: string; host?: HostWindow; dialog?: boolean; theme?: WalletTheme; appearance?: WindowAppearanceInput }) {
    const base = new URL(options.walletUrl);
    this.walletOrigin = base.origin;
    this.url = new URL(`/connect.html?app=${encodeURIComponent(options.appId)}`, base).toString();
    this.host = options.host ?? window;
    this.host.addEventListener("message", this.onMessage as EventListener);
  }

  request<T>(method: WindowMethod, params?: unknown): Promise<T> {
    // The sign-in's look rides with connect; the wallet window checks every field.
    if (method === "connect" && this.options.appearance) params = { ...(params && typeof params === "object" ? params : {}), appearance: this.options.appearance };
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = { id: `${Date.now().toString(36)}-${++this.sequence}`, method, params, resolve: resolve as (value: unknown) => void, reject, sentAt: null, retried: false };
      this.pending.push(entry);
      if (this.popup && !this.popup.closed) {
        if (this.ready) this.send(entry);
        this.showDialog(false);
        return;
      }
      this.openWindow();
    });
  }

  /** Stops listening and closes the window; anything still waiting is refused. */
  destroy() {
    this.host.removeEventListener("message", this.onMessage as EventListener);
    this.failAll(new ProviderRpcError(ERROR_CODES.disconnected, "The wallet was disconnected."));
    this.popup?.close();
  }

  private openWindow() {
    const left = (this.host.screenX ?? 0) + Math.max(0, ((this.host.outerWidth ?? WIDTH) - WIDTH) / 2);
    const top = (this.host.screenY ?? 0) + Math.max(0, ((this.host.outerHeight ?? HEIGHT) - HEIGHT) / 2);
    this.ready = false;
    // Opened straight from the app's click when possible; browsers block windows opened later.
    const popup = this.host.open(this.url, `maxxing-wallet-${this.options.appId}`, `popup=yes,width=${WIDTH},height=${HEIGHT},left=${Math.round(left)},top=${Math.round(top)}`) as Popup | null;
    if (!popup) { this.showDialog(true); return; }
    this.popup = popup;
    this.showDialog(false);
    this.host.clearInterval(this.poll);
    this.poll = this.host.setInterval(() => this.checkClosed(), 400) as unknown as number;
  }

  private send(entry: Pending) {
    entry.sentAt = Date.now();
    this.popup?.postMessage({ protocol: WALLET_PROTOCOL, v: WALLET_PROTOCOL_VERSION, id: entry.id, app: this.options.appId, method: entry.method, params: entry.params }, this.walletOrigin);
  }

  private receive(event: MessageEvent) {
    if (!this.popup || event.source !== (this.popup as unknown) || event.origin !== this.walletOrigin) return;
    const data = event.data as WalletResponse | { protocol: string; event?: string };
    if (!data || data.protocol !== WALLET_PROTOCOL) return;
    if ("event" in data) {
      if (data.event === "ready") {
        this.ready = true;
        for (const entry of this.pending) if (entry.sentAt === null) this.send(entry);
      }
      return;
    }
    const response = data as WalletResponse;
    const index = this.pending.findIndex(entry => entry.id === response.id);
    if (index < 0) return;
    const [entry] = this.pending.splice(index, 1);
    this.lastAnswerAt = Date.now();
    if (response.ok) entry!.resolve(response.result);
    else entry!.reject(new ProviderRpcError(response.error.code ?? ERROR_CODES.internal, response.error.message));
    if (!this.pending.length) this.hideDialog();
  }

  private checkClosed() {
    if (!this.popup?.closed) return;
    this.host.clearInterval(this.poll);
    this.popup = null;
    this.ready = false;
    const retry = this.pending.filter(entry => !entry.retried && entry.sentAt !== null && entry.sentAt - this.lastAnswerAt < CLOSE_RACE_MS && entry.sentAt >= this.lastAnswerAt);
    for (const entry of this.pending) {
      if (retry.includes(entry)) { entry.retried = true; entry.sentAt = null; }
      else entry.reject(new ProviderRpcError(ERROR_CODES.userRejected, "User closed the wallet."));
    }
    this.pending = retry;
    if (retry.length) this.openWindow(); else this.hideDialog();
  }

  private failAll(error: Error) {
    const waiting = this.pending;
    this.pending = [];
    for (const entry of waiting) entry.reject(error);
    this.hideDialog();
  }

  private showDialog(blocked: boolean) {
    if (this.options.dialog === false || typeof document === "undefined") return;
    this.dialog ??= createWaitingDialog({
      onOpen: () => { if (this.popup && !this.popup.closed) this.popup.focus(); else this.openWindow(); },
      onCancel: () => { this.popup?.close(); this.failAll(new ProviderRpcError(ERROR_CODES.userRejected, "User rejected the request.")); },
    }, this.options.theme);
    this.dialog.show(blocked);
  }
  private hideDialog() { this.dialog?.hide(); }
}
