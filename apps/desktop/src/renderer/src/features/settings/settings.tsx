import { ThreadCompletionSettings } from "./thread-completion-settings";
import { AccessSettings } from "./access-settings";
import { ThreadNamingSettings } from "./thread-naming-settings";
import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@tidy/ui/button";
import { Icon } from "@tidy/editor/components/ui/icon";
import type { CloudConnection } from "../cloud/use-cloud";
import { RemoteMachines } from "./remote-machines";
import { PrivacySettings } from "./privacy-settings";
import { AppearanceSettings } from "./appearance-settings";
import { TerminalSettings } from "./terminal-settings";

export const settingsPages = [
  "account",
  "appearance",
  "threads",
  "terminal",
  "privacy",
  "remote",
] as const;
export type SettingsPage = (typeof settingsPages)[number];

export const settingsSections = {
  account: "Account",
  appearance: "Appearance",
  threads: "Threads",
  terminal: "Terminal",
  privacy: "Privacy",
  remote: "Remote machines",
} satisfies Record<SettingsPage, string>;

export function Settings({
  cloud,
  onBack,
  initialPage = "account",
  active = true,
}: {
  cloud: CloudConnection;
  active?: boolean;
  onBack(): void;
  initialPage?: SettingsPage;
}) {
  const [page, setPage] = useState<SettingsPage>(initialPage);
  const machines = window.tidyMachines;
  const remote = window.tidyRemote;
  const back = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!active) return;
    setPage(initialPage);
    back.current?.focus();
  }, [active, initialPage]);
  const [remoteVisited, setRemoteVisited] = useState(false);
  if (page === "remote" && !remoteVisited) setRemoteVisited(true);
  const available = cloud.state?.available;
  const signedIn = cloud.state?.signedIn;

  return (
    <>
      <aside
        hidden={!active}
        id="desktop-settings-navigation"
        className="desktop-navigation col-start-1 row-span-full flex min-h-0 min-w-0 flex-col border-r border-border bg-(--desktop-navigation-surface) settings-navigation [@media(max-width:600px)]:[&:not([hidden])]:col-[1] [@media(max-width:600px)]:[&:not([hidden])]:row-[1] [@media(max-width:600px)]:[&:not([hidden])]:border-r-0 [@media(max-width:600px)]:[&:not([hidden])]:border-b [&[hidden]]:hidden"
        aria-label="Settings"
      >
        <div className="workspace-header flex shrink-0 flex-col gap-1.5 px-1 pt-1 pb-2">
          <Button ref={back} className="settings-back" onClick={onBack}>
            <Icon name="back" size={16} />
            Back to app
          </Button>
        </div>
        <nav
          className="settings-sections flex min-h-0 flex-col gap-1 overflow-y-auto overscroll-contain px-2 py-[18px] [@media(max-width:600px)]:flex-row [@media(max-width:600px)]:overflow-x-auto [@media(max-width:600px)]:pt-0 [@media(max-width:600px)]:pb-2"
          aria-label="Settings sections"
        >
          <span className="settings-label [@media(max-width:600px)]:hidden">Settings</span>
          {settingsPages
            .filter((item) => item !== "remote")
            .map((item) => (
              <Button
                key={item}
                className="settings-section shrink-0 [@media(max-width:600px)]:whitespace-nowrap"
                aria-current={page === item ? "page" : undefined}
                aria-controls={`settings-${item}-panel`}
                onClick={() => setPage(item)}
              >
                {settingsSections[item]}
              </Button>
            ))}
          {machines && remote && (
            <Button
              className="settings-section shrink-0 [@media(max-width:600px)]:whitespace-nowrap"
              aria-current={page === "remote" ? "page" : undefined}
              aria-controls="settings-remote-panel"
              onClick={() => setPage("remote")}
            >
              {settingsSections.remote}
            </Button>
          )}
        </nav>
      </aside>
      <main
        hidden={!active}
        className="workspace settings-workspace px-[clamp(24px,5vw,64px)] py-10 [@media(max-width:600px)]:col-[1]! [@media(max-width:600px)]:row-[2]! [@media(max-width:600px)]:px-4 [@media(max-width:600px)]:py-6 [&[hidden]]:hidden"
        aria-labelledby="settings-title"
      >
        <div className="settings-content">
          <h1 id="settings-title">{settingsSections[page]}</h1>
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
          {remoteVisited && machines && remote && (
            <div id="settings-remote-panel" hidden={page !== "remote"}>
              <RemoteMachines
                machines={machines}
                remote={remote}
                active={active && page === "remote"}
              />
            </div>
          )}
          <div id="settings-appearance-panel" hidden={page !== "appearance"}>
            <AppearanceSettings />
          </div>
          <div id="settings-threads-panel" hidden={page !== "threads"}>
            <AccessSettings />
            <ThreadNamingSettings />
            <ThreadCompletionSettings />
          </div>
          <div id="settings-terminal-panel" hidden={page !== "terminal"}>
            <TerminalSettings />
          </div>
          <div id="settings-privacy-panel" hidden={page !== "privacy"}>
            <PrivacySettings active={active} />
          </div>
        </div>
      </main>
    </>
  );
}
