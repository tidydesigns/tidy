import { useId, useSyncExternalStore } from "react";
import { Button } from "@tidy/ui/button";
import { showToast } from "@tidy/ui/toast";
import { currentTheme, selectTheme, subscribeTheme } from "../../theme";

export function AppearanceSettings() {
  const theme = useSyncExternalStore(subscribeTheme, currentTheme);
  const labelId = useId();

  return (
    <div className="settings-appearance-row">
      <span id={labelId}>Dark mode</span>
      <Button
        type="button"
        role="switch"
        aria-checked={theme === "dark"}
        aria-labelledby={labelId}
        className="settings-theme-switch"
        onClick={() => {
          if (!selectTheme(currentTheme() === "dark" ? "light" : "dark")) {
            showToast("Theme changed for this session, but could not be remembered.");
          }
        }}
      >
        <span className="settings-theme-thumb" aria-hidden="true" />
      </Button>
    </div>
  );
}
