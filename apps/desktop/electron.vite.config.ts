import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import { bundleLicenseBannerForInputs } from "../../scripts/bundle-licenses";
import tailwindcss from "@tailwindcss/vite";

const licenceBanner = (chunk: { modules: Record<string, unknown> }) =>
  bundleLicenseBannerForInputs(Object.keys(chunk.modules));

export default defineConfig({
  main: {
    build: {
      externalizeDeps: false,
      rolldownOptions: { output: { banner: licenceBanner } },
    },
  },
  preload: {
    build: {
      rolldownOptions: { output: { format: "cjs", entryFileNames: "index.cjs" } },
    },
  },
  renderer: {
    worker: { format: "es", rolldownOptions: { output: { banner: licenceBanner } } },
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "desktop-development-csp",
        apply: "serve",
        transformIndexHtml(html) {
          return html
            .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
            .replace("connect-src 'self'", "connect-src 'self' ws://127.0.0.1:5173");
        },
      },
    ],
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
    },
    build: {
      rolldownOptions: {
        output: {
          banner: (chunk) => bundleLicenseBannerForInputs(Object.keys(chunk.modules)),
        },
      },
    },
  },
});
