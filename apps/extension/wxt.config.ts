import { defineConfig } from "wxt";
import { EXTENSION_KEY } from "@tidy/design/extension";
import { appOrigin } from "./lib/app-origin";
import { createHash } from "node:crypto";
import { bundleLicenseBannerForInputs } from "../../scripts/bundle-licenses";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  vite: ({ command }) => ({
    plugins: [
      {
        name: "tidy-bundled-licenses",
        async generateBundle(_options, bundle) {
          // Live-reload tooling is injected only during development, outside release bundles.
          if (command === "serve") return;
          const inputs = new Set<string>();
          for (const output of Object.values(bundle)) {
            if (output.type !== "chunk") continue;
            for (const [id, module] of Object.entries(output.modules))
              if (module.renderedLength > 0 && !id.startsWith("\0")) inputs.add(id);
          }
          const notices = await bundleLicenseBannerForInputs(inputs);
          if (!notices) return;
          const hash = createHash("sha256").update(notices).digest("hex").slice(0, 12);
          this.emitFile({
            type: "asset",
            fileName: `licenses/third-party-${hash}.txt`,
            source: notices,
          });
        },
      },
    ],
  }),
  hooks: {
    "build:before"(wxt) {
      appOrigin(process.env.WXT_BELLA_URL, wxt.config.mode === "production");
    },
  },
  manifest: () => {
    const origin = appOrigin(process.env.WXT_BELLA_URL);
    return {
      name: "Tidy: Website to Design",
      minimum_chrome_version: "127",
      description: "Import webpages and selected elements into your Tidy design files.",
      key: EXTENSION_KEY,
      permissions: ["activeTab", "scripting", "storage"],
      host_permissions: [`${origin}/*`],
      icons: { 16: "icon/16.png", 48: "icon/48.png", 128: "icon/128.png" },
    };
  },
});
