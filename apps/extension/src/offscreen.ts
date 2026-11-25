/**
 * The offscreen document (Chrome): the background opens it for a moment to empty the clipboard after a secret was copied, because
 * a service worker has no clipboard and the popup that copied may be closed by then. It only ever writes an empty string.
 */
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== chrome.runtime.id || message?.type !== "offscreen-clear-clipboard") return false;
  const onCopy = (event: ClipboardEvent) => { event.clipboardData?.setData("text/plain", ""); event.preventDefault(); };
  document.addEventListener("copy", onCopy);
  try { document.execCommand("copy"); } finally { document.removeEventListener("copy", onCopy); }
  return false;
});
