/** Empties the clipboard only if it still holds the copied secret, recognised by its SHA-256. Returns whether it cleared. */
export async function clearIfSame(read: () => string, empty: () => void, hash: string): Promise<boolean> {
  const now = read();
  if (!now) return false;
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(now)))].map(b => b.toString(16).padStart(2, "0")).join("");
  if (digest !== hash) return false;
  empty();
  return true;
}
