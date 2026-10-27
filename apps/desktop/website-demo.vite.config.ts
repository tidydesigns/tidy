import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { rendererConfig } from "./electron.vite.config.ts";

export default defineConfig({
  ...rendererConfig,
  root: fileURLToPath(new URL("./src/website-demo", import.meta.url)),
  base: "/desktop-demo/",
  build: {
    ...rendererConfig.build,
    outDir: fileURLToPath(new URL("./demo-dist", import.meta.url)),
    emptyOutDir: true,
  },
});
