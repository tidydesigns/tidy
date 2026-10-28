import { useEffect, useRef, useState } from "react";
import { Button } from "@tidy/ui/button";
import { Icon } from "@tidy/editor/components/ui/icon";
import type { CloudConnection } from "../cloud/use-cloud";
import { RemoteMachines } from "./remote-machines";
import { PrivacySettings } from "./privacy-settings";

export function Settings({
  cloud,
  onBack,
  initialPage = "account",
}: {
  cloud: CloudConnection;
  onBack(): void;
  initialPage?: "account" | "remote";
}) {
  const [page, setPage] = useState<"account" | "privacy" | "remote">(initialPage);
  const machines = window.tidyMachines;
  const remote = window.tidyRemote;
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => back.current?.focus(), []);
  const available = cloud.state?.available;
  const signedIn = cloud.state?.signedIn;

  return (
    <>
      <aside
        id="desktop-settings-navigation"
        className="desktop-navigation col-start-1 row-span-full flex min-h-0 min-w-0 flex-col border-r border-border bg-(--desktop-navigation-surface) settings-navigation"
        aria-label="Settings"
      >
        <div className="workspace-header flex shrink-0 flex-col gap-1.5 px-1 pt-1 pb-2">
          <Button ref={back} className="settings-back" onClick={onBack}>
            <Icon name="back" size={16} />
            Back to app
          </Button>
        </div>
        <nav className="settings-sections" aria-label="Settings sections">
          <span className="settings-label">Settings</span>
          {(["account", "privacy"] as const).map((item) => (
            <Button
              key={item}
              className="settings-section"
              aria-current={page === item ? "page" : undefined}
              aria-controls={`settings-${item}-panel`}
              onClick={() => setPage(item)}
            >
              {item === "account" ? "Account" : "Privacy"}
            </Button>
          ))}
          {machines && remote && (
            <Button
              className="settings-section"
              aria-current={page === "remote" ? "page" : undefined}
              aria-controls="settings-remote-panel"
              onClick={() => setPage("remote")}
            >
              Remote machines
            </Button>
          )}
        </nav>
      </aside>
      <main className="workspace settings-workspace" aria-labelledby="settings-title">
        <div className="settings-content">
          <h1 id="settings-title">
            {page === "account" ? "Account" : page === "privacy" ? "Privacy" : "Remote machines"}
          </h1>
          <section
            id="settings-account-panel"
            hidden={page !== "account"}
            className="settings-account"
            aria-labelledby="settings-account-title"
          >
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
          {page === "remote" && machines && remote && (
            <div id="settings-remote-panel">
              <RemoteMachines machines={machines} remote={remote} />
            </div>
          )}
          <div id="settings-privacy-panel" hidden={page !== "privacy"}>
            <PrivacySettings />
          </div>
        </div>
      </main>
    </>
  );
}
