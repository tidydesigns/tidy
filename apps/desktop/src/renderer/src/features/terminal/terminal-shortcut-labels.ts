export function terminalShortcutLabels(mac: boolean) {
  const mod = mac ? "⌘" : "Ctrl+";
  const shift = mac ? "⇧" : "Shift+";
  return {
    toggle: "Ctrl+`",
    newGlobal: "Ctrl+Shift+`",
    new: `${mod}T`,
    close: `${mod}W`,
    maximize: `${mod}Enter`,
    next: ["Ctrl+Tab", `${mac ? shift + mod : mod + shift}]`],
    previous: ["Ctrl+Shift+Tab", `${mac ? shift + mod : mod + shift}[`],
    select: `${mod}1–8`,
    zoomIn: `${mod}+`,
    zoomOut: `${mod}−`,
    zoomReset: `${mod}0`,
    copy: mac ? "⌘C" : "Ctrl+Shift+C",
    tab: (index: number) => `${mod}${index + 1}`,
  };
}
