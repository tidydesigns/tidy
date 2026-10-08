import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { bundleLicenseBanner } from "../../../scripts/bundle-licenses";

export async function buildPlugin() {
  const root = resolve(import.meta.dir, "..");
  const build = await Bun.build({
    entrypoints: [resolve(root, "src/app.tsx")],
    target: "browser",
    format: "esm",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
    metafile: true,
  });
  if (!build.success) throw new Error(build.logs.join("\n"));
  const script = ((await bundleLicenseBanner(build)) + (await build.outputs[0].text())).replace(
    /<\/script/gi,
    "<\\/script",
  );
  const css = await Bun.file(resolve(root, "src/style.css")).text();
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tidy</title><style>${css}</style></head><body><div id="root"></div><script type="module">${script}</script></body></html>`;
  const hash = createHash("sha256").update(html).digest("hex").slice(0, 16);
  await Bun.write(
    resolve(root, "dist/widget.js"),
    `export const widgetUri = "ui://tidy/design-${hash}.html";\nexport const widgetHtml = ${JSON.stringify(html)};\n`,
  );
  await Bun.write(
    resolve(root, "dist/widget.d.ts"),
    "export declare const widgetUri: string;\nexport declare const widgetHtml: string;\n",
  );
  await Bun.write(resolve(root, "dist/widget.html"), html);
  return html;
}
if (import.meta.main) {
  await buildPlugin();
  console.log("Built Tidy plugin UI.");
}
