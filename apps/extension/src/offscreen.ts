/**
 * The offscreen document (Chrome): the background opens it for a moment to clear a copied secret from the clipboard, because a
 * service worker has no clipboard and the popup that copied may be closed by then. It reads the clipboard, and empties it only
 * if it still holds the secret (same SHA-256 as when it was copied), so anything the user copied since stays.
 */
import { clearIfSame } from "./lib/clipboard";

function readClipboard(): string {
  const area = document.createElement("textarea");
  document.body.append(area);
  area.focus();
  try { document.execCommand("paste"); return area.value; } finally { area.remove(); }
}

function emptyClipboard() {
  const onCopy = (event: ClipboardEvent) => { event.clipboardData?.setData("text/plain", ""); event.preventDefault(); };
  document.addEventListener("copy", onCopy);
  try { document.execCommand("copy"); } finally { document.removeEventListener("copy", onCopy); }
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || message?.type !== "offscreen-clear-clipboard" || typeof message.hash !== "string") return false;
  clearIfSame(readClipboard, emptyClipboard, message.hash).then(reply, () => reply(false));
  return true;
});
