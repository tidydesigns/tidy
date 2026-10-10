import { createRoot } from "react-dom/client";
import { App } from "./App";
import { browser } from "wxt/browser";
import { applyTheme } from "../../lib/theme";
import "./style.css";

void browser.storage.local
  .get("theme")
  .catch(() => ({}) as { theme?: unknown })
  .then(({ theme }) => {
    applyTheme(theme);
    createRoot(document.getElementById("root")!).render(<App />);
  });
