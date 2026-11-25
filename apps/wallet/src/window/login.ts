/**
 * Where a provider sign-in lands (wallet.maxxing.ad/login.html#nonce=…&ticket=…). It hands the one-time ticket to the
 * wallet window that started the sign-in, over a same-origin channel (providers' pages often cut window.opener), and closes.
 * The ticket alone is useless: redeeming it also needs the secret only that wallet window holds.
 */
import { LOGIN_CHANNEL } from "./login-channel";

const params = new URLSearchParams(location.hash.slice(1));
// Keep the ticket out of history.
history.replaceState(null, "", location.pathname);
const nonce = params.get("nonce"), ticket = params.get("ticket"), error = params.get("error");
const app = document.getElementById("app")!;
const main = document.createElement("main");
main.className = "center";
const text = document.createElement("p");
main.append(text);
app.append(main);

if (nonce && /^[A-Za-z0-9_-]{16,64}$/.test(nonce) && (ticket || error)) {
  const channel = new BroadcastChannel(LOGIN_CHANNEL);
  channel.postMessage({ nonce, ticket, error });
  channel.close();
  text.textContent = error ? "Sign-in didn't finish. You can close this window." : "Signed in. Returning to the wallet…";
  setTimeout(() => window.close(), error ? 1500 : 300);
} else {
  text.textContent = "Nothing to do here. You can close this window.";
}
