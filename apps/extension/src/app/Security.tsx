import { useState } from "react";
import { PageHead, PasswordForm, message } from "./kit";
import { NewPin } from "./Onboarding";
import * as wallet from "../lib/wallet";
import { t } from "../lib/strings";

/**
 * Changing the one password: the current one first (wrong tries count and wait as at unlock), then the new one twice. Only the
 * password's wrap of the master key changes, so every wallet and account opens with the new one at once.
 */
export function ChangePassword({ onDone, toast }: { onDone: () => void; toast: (t: string) => void }) {
  const [current, setCurrent] = useState<string | null>(null);
  const [error, setError] = useState(""), [waitUntil, setWaitUntil] = useState(wallet.pinWaitUntil());
  return <div className="popup"><div className="backdrop" />
    <PageHead title={t("settings.changePassword")} onBack={onDone} />
    <div className="scroll" data-testid="change-password">
      {current === null
        ? <PasswordForm key="current" title={t("password.current")} label="Current password" error={error} waitUntil={waitUntil} onComplete={async pin => {
          // Checked against the keyring itself, with the same counted, growing waits as the lock screen; nothing opens or is logged.
          try { setError(""); await wallet.checkPassword(pin); setCurrent(pin); } catch (e) { setError(message(e)); setWaitUntil(wallet.pinWaitUntil()); }
        }} />
        : <NewPin title={t("password.new")} onPin={async pin => {
          if (pin === current) throw new Error("That's the password you have now. Choose a different one.");
          await wallet.changePassword(current, pin);
          toast(t("password.changed")); onDone();
        }} />}
    </div>
  </div>;
}
