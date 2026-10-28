import { useId, useSyncExternalStore } from "react";
import { SelectMenu } from "@tidy/ui/select-menu";
import { showToast } from "@tidy/ui/toast";
import { currentThemePreference, selectTheme, subscribeTheme } from "../../theme";

const options = [
  { value: "system", label: "System default" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

export function AppearanceSettings() {
  const theme = useSyncExternalStore(subscribeTheme, currentThemePreference);
  const labelId = useId();

  return (
    <div className="settings-appearance-row">
      <span id={labelId}>Theme</span>
      <SelectMenu
        value={theme}
        options={options}
        label="Theme"
        labelledBy={labelId}
        className="w-44 shrink-0"
        size="sm"
        onChange={(value) => {
          if (value !== "system" && value !== "dark" && value !== "light") return;
          if (!selectTheme(value)) {
            showToast("Theme changed for this session, but could not be remembered.");
          }
        }}
      />
    </div>
  );
}
