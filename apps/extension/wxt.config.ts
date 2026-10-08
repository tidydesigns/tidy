import { defineConfig } from "wxt";
import { EXTENSION_KEY } from "@bella/design/extension";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: () => {
    const url = new URL(process.env.WXT_BELLA_URL ?? "http://localhost:3000");
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" && !(url.hostname === "localhost" && url.protocol === "http:"))
    ) {
      throw new Error("WXT_BELLA_URL must be an HTTPS origin or http://localhost:<port>.");
    }
    return {
      name: "Tidy — Copy website to design",
      description: "Import webpages and selected elements into your Tidy design files.",
      key: EXTENSION_KEY,
      permissions: ["activeTab", "scripting", "storage"],
      host_permissions: [`${url.origin}/*`],
      icons: { 16: "icon/16.png", 48: "icon/48.png", 128: "icon/128.png" },
    };
  },
});
