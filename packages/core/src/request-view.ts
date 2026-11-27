/**
 * What the wallet shows before it signs a request: one screen's worth of plain words, built from the request by the review code
 * (review.ts, sign-in.ts). Every MAXXING wallet (the wallet window and the browser extension) builds its approval screens from
 * this, and signs the parameters this returns: the request as it was shown, a transaction as checked field by field.
 */
import { ALLOWED_DELEGATE } from "./signing";
import { checkedTransaction, messageForDisplay, networkKnown, networkName, solanaBytesView, transactionSummary, typedDataSummary, type Row } from "./review";
import { checkSignIn, untilText } from "./sign-in";

/** The standard EIP-1193 wording for a declined request, with its code, which apps and viem already recognise. */
export const USER_REJECTED = "User rejected the request.";
export const USER_REJECTED_CODE = 4001;

/** Methods that make a signature. */
export const SIGNING_METHODS = ["evm.signMessage", "evm.signTypedData", "evm.signTransaction", "evm.signAuthorization", "solana.signBytes"] as const;
export type SigningMethod = (typeof SIGNING_METHODS)[number];
export const isSigningMethod = (method: string): method is SigningMethod => (SIGNING_METHODS as readonly string[]).includes(method);

export type ApprovalView = {
  /** One line: what the request is. */
  title: string;
  /** The site asking. */
  site: string;
  /** Plain-language lines: what it does. */
  actions: string[];
  rows: Row[];
  warnings: string[];
  /** A message to read in full. */
  text?: { text: string; raw: boolean };
};

const SIGN_IN_PROBLEMS: Record<string, string> = {
  SIGN_IN_WRONG_SITE: "This sign-in is for a different site than the one asking.",
  SIGN_IN_WRONG_ACCOUNT: "This sign-in names a different account.",
  SIGN_IN_EXPIRED: "This sign-in has expired.",
  SIGN_IN_NOT_YET_VALID: "This sign-in isn't valid yet.",
};

/**
 * The approval screen for a signing request, and the parameters to sign: the same request, normalised where showing it needs that.
 * Throws when a request can't be shown faithfully; such a request is never signed.
 */
export function approvalView(method: SigningMethod, params: any, origin: string, wallet: { evm: string; solana: string }): { view: ApprovalView; params: any } {
  const site = (() => { try { return new URL(origin).host; } catch { return origin; } })();
  const view: ApprovalView = { title: "", site, actions: [], rows: [], warnings: [] };
  switch (method) {
    case "evm.signMessage": {
      const shown = messageForDisplay(params?.message);
      const signIn = shown.raw ? null : checkSignIn(shown.text, origin, wallet.evm);
      if (signIn?.ok) {
        view.title = `Sign in to ${signIn.message.domain}`;
        if (signIn.message.statement) view.actions.push(signIn.message.statement);
        if (signIn.message.expirationTime) view.rows.push(["Expires", untilText(signIn.message.expirationTime)]);
        view.warnings.push(...signIn.warnings);
      } else {
        view.title = "Sign a message";
        if (signIn) view.warnings.push(SIGN_IN_PROBLEMS[signIn.code] ?? "This sign-in doesn't match.");
      }
      view.text = shown;
      return { view, params };
    }
    case "evm.signTypedData": {
      const summary = typedDataSummary(params);
      view.title = summary.spending ? "Approve a spending permission" : `Sign ${summary.kind}`;
      if (summary.app) view.rows.push(["For", summary.app]);
      if (summary.network) view.rows.push(["Network", summary.network]);
      if (summary.contract) view.rows.push(["Contract", summary.contract]);
      view.rows.push(...summary.rows);
      if (summary.unlimited) view.warnings.push("There's no limit on the amount: this permission covers all of that token, now and later.");
      if (summary.spending) view.warnings.push("This lets someone else move your tokens. Only approve if you expect it.");
      if (summary.network && !networkKnown((params as { domain?: { chainId?: unknown } }).domain?.chainId)) view.warnings.push("This network isn't one MAXXING lists.");
      return { view, params };
    }
    case "evm.signTransaction": {
      const transaction = checkedTransaction(params?.transaction);
      const summary = transactionSummary(transaction);
      view.title = summary.callsContract ? "Confirm a transaction" : `Send ${summary.amount}`;
      if (summary.tokenCall) view.actions.push(summary.tokenCall.text);
      // Code the wallet can't read is said plainly, never left looking like an ordinary send.
      else if (summary.callsContract) view.actions.push("Runs this contract's code, which the wallet can't read. It can move tokens you've let it spend, and the amount sent with it.");
      view.rows.push(["Network", summary.network]);
      // In full: a shortened address can be imitated by one that starts and ends the same.
      if (summary.to) view.rows.push([summary.callsContract ? "Contract" : "To", summary.to]);
      view.rows.push(["Amount", summary.amount]);
      if (summary.maxFee) view.rows.push(["Network fee, at most", summary.maxFee]);
      view.rows.push(...summary.rows);
      if (summary.tokenCall?.warning) view.warnings.push(summary.tokenCall.warning);
      if (!networkKnown(transaction.chainId)) view.warnings.push("This network isn't one MAXXING lists.");
      return { view, params: { transaction } };
    }
    case "evm.signAuthorization": {
      if (typeof params?.address !== "string" || params.address.toLowerCase() !== ALLOWED_DELEGATE.toLowerCase()) throw new Error("RELAY_AUTHORIZATION_DELEGATE");
      view.title = "Turn on gasless trading";
      view.actions.push(`Your account on ${networkName(params.chainId)} can then run trades you sign without holding gas. It runs only what you sign.`);
      view.rows.push(["Network", networkName(params.chainId)], ["Delegates to (Relay)", ALLOWED_DELEGATE]);
      return { view, params };
    }
    case "solana.signBytes": {
      const shown = solanaBytesView(params?.bytes, wallet.solana);
      if (shown.kind === "message") {
        view.title = "Sign a message";
        view.text = { text: shown.text, raw: shown.raw };
        return { view, params };
      }
      const summary = shown.summary;
      view.title = "Confirm a Solana transaction";
      view.actions.push(...summary.actions.map(a => a.text));
      view.rows.push(["Network", "Solana"], ...summary.rows);
      view.warnings.push(...summary.actions.flatMap(a => a.warning ? [a.warning] : []));
      if (summary.usesLookupTables) view.warnings.push("Some accounts come from lookup tables and can't be named here.");
      return { view, params };
    }
  }
}
