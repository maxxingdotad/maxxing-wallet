import { createRoot } from "react-dom/client";
import "./ui/styles.css";
import { App } from "./app/App";

/** The same wallet in three places: the toolbar popup (360×600), Chrome's side panel, and a full tab. */
const mode = document.body.dataset.mode === "panel" ? "panel" : new URLSearchParams(location.search).get("mode") === "tab" ? "tab" : "popup";
document.body.dataset.mode = mode;
createRoot(document.getElementById("app")!).render(<App mode={mode} />);
