import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import { bundleLicenseBannerForInputs } from "../../scripts/bundle-licenses";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const licenceBanner = (chunk: { modules: Record<string, unknown> }) =>
  bundleLicenseBannerForInputs(Object.keys(chunk.modules));

export const rendererConfig = {
  worker: {
    format: "es",
    rolldownOptions: { output: { banner: licenceBanner, comments: { legal: true } } },
  },
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
    minify: true,
    rolldownOptions: {
      output: {
        comments: { legal: true },
        banner: (chunk) => bundleLicenseBannerForInputs(Object.keys(chunk.modules)),
      },
    },
  },
} satisfies import("vite").UserConfig;

export default defineConfig({
  main: {
    build: {
      minify: true,
      externalizeDeps: false,
      rolldownOptions: {
        input: {
          index: fileURLToPath(new URL("./src/main/index.ts", import.meta.url)),
          "cloud-compute-worker": fileURLToPath(
            new URL("./src/main/cloud/cloud-compute-worker.ts", import.meta.url),
          ),
        },
        output: { banner: licenceBanner },
      },
    },
  },
  preload: {
    build: {
      minify: true,
      externalizeDeps: false,
      rolldownOptions: {
        output: { format: "cjs", entryFileNames: "index.cjs", banner: licenceBanner },
      },
    },
  },
  renderer: rendererConfig,
});
