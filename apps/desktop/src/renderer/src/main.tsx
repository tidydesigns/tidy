import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import "@tidy/ui/fonts.css";
import "./styles.css";

if (import.meta.env.DEV && !window.tidy) await import("./browser-api");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
