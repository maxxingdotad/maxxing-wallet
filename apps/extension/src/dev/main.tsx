// The shim first: the wallet's modules reach for `chrome` as they load.
import "./chrome-shim";
import { createRoot } from "react-dom/client";
import "../ui/styles.css";
import { App } from "../app/App";

/**
 * Development only: the real wallet in a normal tab at http://localhost:8085/dev.html, with vite's live reload. Styles update in
 * place; code changes reload the page and an unlocked wallet stays unlocked.
 *   ?mode=tab    the full-tab layout instead of the 360×600 popup
 *   ?reset       removes the dev wallet and starts at the welcome screen
 *   ?demo        test mode: sample balances, and sends and swaps that finish without touching any network (?demo=off to leave)
 * Site connections need the installed extension (there is no background here).
 */
const params = new URLSearchParams(location.search);
if (params.has("reset")) {
  const databases = await indexedDB.databases().catch(() => []);
  await Promise.all(databases.map(d => d.name && new Promise(done => { const r = indexedDB.deleteDatabase(d.name!); r.onsuccess = r.onerror = r.onblocked = done; })));
  const demoOn = sessionStorage.getItem("maxxing-dev:demo");
  sessionStorage.clear(); localStorage.clear();
  if (demoOn) sessionStorage.setItem("maxxing-dev:demo", demoOn);
  params.delete("reset");
  location.replace(`${location.pathname}${params.size ? `?${params}` : ""}`);
}
// Test mode stays on for this tab once chosen, until ?demo=off.
if (params.has("demo")) { if (params.get("demo") === "off") sessionStorage.removeItem("maxxing-dev:demo"); else sessionStorage.setItem("maxxing-dev:demo", "1"); }
const demo = sessionStorage.getItem("maxxing-dev:demo") === "1";
if (demo) await import("./demo");

const mode = params.get("mode") === "tab" ? "tab" : "popup";
document.body.dataset.mode = mode;
document.body.classList.add("dev-host");
const link = (label: string, query: string) => <a href={`${location.pathname}?${query}`}>{label}</a>;
const bar = <div className="dev-bar">
  <b>{demo ? "Test mode · sample funds, nothing is sent" : "Live · real networks"}</b>
  <span>{demo ? link("Leave test mode", "demo=off") : link("Test mode", "demo")} · {link("Start over", "reset")} · {mode === "tab" ? link("Popup", "") : link("Full tab", "mode=tab")}</span>
</div>;
createRoot(document.getElementById("app")!).render(mode === "tab"
  ? <>{bar}<App mode="tab" /></>
  : <div className="dev-stage">{bar}<div className="dev-frame"><App mode="popup" /></div></div>);
