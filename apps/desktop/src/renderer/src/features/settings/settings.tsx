import { useEffect, useRef } from "react";
import { Button } from "@tidy/ui/button";
import { Icon } from "@tidy/editor/components/ui/icon";
import type { CloudConnection } from "../cloud/use-cloud";

export function Settings({ cloud, onBack }: { cloud: CloudConnection; onBack(): void }) {
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => back.current?.focus(), []);
  const available = cloud.state?.available;
  const signedIn = cloud.state?.signedIn;

  return (
    <>
      <aside
        id="desktop-settings-navigation"
        className="desktop-navigation settings-navigation"
        aria-label="Settings"
      >
        <div className="workspace-header">
          <Button ref={back} className="settings-back" onClick={onBack}>
            <Icon name="back" size={16} />
            Back to app
          </Button>
        </div>
        <nav className="settings-sections" aria-label="Settings sections">
          <span className="settings-label">Settings</span>
          <a href="#settings-account" className="settings-section" aria-current="page">
            Account
          </a>
        </nav>
      </aside>
      <main className="workspace settings-workspace" aria-labelledby="settings-title">
        <div className="settings-content">
          <h1 id="settings-title">Account</h1>
          <section className="settings-account" aria-labelledby="settings-account-title">
            <div className="settings-account-row" id="settings-account">
              <div>
                <h2 id="settings-account-title">Sync</h2>
                <p>
                  {signedIn
                    ? "Workspace designs sync automatically."
                    : "Sign in to sync workspace designs across devices."}
                </p>
              </div>
              <div className="settings-account-actions">
                {cloud.busy ? (
                  <>
                    <span className="settings-waiting" role="status">
                      Continue in your browser…
                    </span>
                    <Button className="secondary-button" onClick={() => void cloud.signOut()}>
                      Cancel sign-in
                    </Button>
                  </>
                ) : (
                  <Button
                    className="secondary-button"
                    disabled={!available}
                    onClick={() => void (signedIn ? cloud.signOut() : cloud.signIn())}
                  >
                    {signedIn ? "Sign out" : "Sign in"}
                  </Button>
                )}
              </div>
            </div>
            {cloud.error && (
              <p className="settings-account-error" role="alert">
                {cloud.error}
              </p>
            )}
            {cloud.state && !available && (
              <p className="settings-account-note">Cloud sync is unavailable on this device.</p>
            )}
            <p className="settings-account-note">
              Local projects stay on this computer unless you add them to a workspace.
            </p>
          </section>
        </div>
      </main>
    </>
  );
}
