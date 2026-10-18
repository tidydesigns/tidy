import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import { bundleLicenseBannerForInputs } from "../../scripts/bundle-licenses";

export default defineConfig({
  main: {},
  renderer: {
    plugins: [
      react(),
      {
        name: "desktop-development-csp",
        apply: "serve",
        transformIndexHtml(html) {
          return html
            .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
            .replace("style-src 'self'", "style-src 'self' 'unsafe-inline'")
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
