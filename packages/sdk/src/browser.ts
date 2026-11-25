/**
 * The script-tag build: everything in one file, no bundler needed.
 *   <script src="https://developers.maxxing.ad/sdk/v0/maxxing-wallet.js"></script>
 *   <maxxing-connect app-id="app_…"></maxxing-connect>
 * Also sets `window.MaxxingWallet` (createMaxxingWallet, mountConnectButton, …) for code on the page.
 */
import * as sdk from "./index";
import { defineConnectElement } from "./element";

defineConnectElement();
declare global { interface Window { MaxxingWallet: typeof sdk } }
if (typeof window !== "undefined") window.MaxxingWallet = sdk;
