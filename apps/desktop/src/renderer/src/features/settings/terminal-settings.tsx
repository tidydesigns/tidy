import { useId, useSyncExternalStore } from "react";
import { SelectMenu } from "@tidy/ui/select-menu";
import { showToast } from "@tidy/ui/toast";
import { terminalFont } from "../terminal/terminal-font";
import {
  currentTerminalFontSize,
  selectTerminalFontSize,
  subscribeTerminalFontSize,
} from "../terminal/terminal-preferences";
import { terminalShortcutLabels } from "../terminal/terminal-shortcut-labels";

const sizes = Array.from({ length: terminalFont.max - terminalFont.min + 1 }, (_, index) => {
  const size = terminalFont.min + index;
  return {
    value: String(size),
    label: `${size} px${size === terminalFont.default ? " (default)" : ""}`,
  };
});

export function TerminalSettings() {
  const size = useSyncExternalStore(subscribeTerminalFontSize, currentTerminalFontSize);
  const labelId = useId();
  const shortcuts = terminalShortcutLabels(navigator.platform.includes("Mac"));
  const groups = [
    {
      label: "Anywhere in the app",
      rows: [
        ["Show or hide terminal", [shortcuts.toggle]],
        ["New terminal", [shortcuts.newGlobal]],
      ],
    },
    {
      label: "While the terminal is focused",
      rows: [
        ["New tab", [shortcuts.new]],
        ["Close tab", [shortcuts.close]],
        ["Full screen or restore", [shortcuts.maximize]],
        ["Next tab", shortcuts.next],
        ["Previous tab", shortcuts.previous],
        ["Switch to tab 1–8", [shortcuts.select]],
        ["Increase text size", [shortcuts.zoomIn]],
        ["Decrease text size", [shortcuts.zoomOut]],
        ["Reset text size", [shortcuts.zoomReset]],
        ["Copy selection", [shortcuts.copy]],
      ],
    },
  ] satisfies { label: string; rows: [string, string[]][] }[];
  return (
    <div className="terminal-settings">
      <div className="settings-appearance-row">
        <span id={labelId}>Text size</span>
        <SelectMenu
          value={String(size)}
          options={sizes}
          label="Terminal text size"
          labelledBy={labelId}
          size="sm"
          className="w-40 shrink-0"
          onChange={(value) => {
            if (!selectTerminalFontSize(Number(value)))
              showToast("Text size changed for this session, but could not be remembered.");
          }}
        />
      </div>
      <p className="terminal-settings-note">
        Terminal colors follow the app theme. Text size applies to all terminals.
      </p>
      <h2>Keyboard shortcuts</h2>
      {groups.map((group) => (
        <table className="terminal-shortcuts" key={group.label}>
          <caption>{group.label}</caption>
          <tbody>
            {group.rows.map(([label, keys]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td>
                  {keys.map((key, index) => (
                    <span key={key}>
                      {index > 0 && <span className="terminal-shortcut-or">or</span>}
                      <kbd>{key}</kbd>
                    </span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </div>
  );
}
