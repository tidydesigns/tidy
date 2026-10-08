import { expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { exportComponent } from "./code-export";
import { codeRuntimeSource } from "./code-runtime.generated";
import { composeComponent, componentTreeSchema } from "./compose-component";
import { designNodeChangesSchema } from "./document";

mock.module("server-only", () => ({}));
const { buttonExample } = await import("../mcp/design-tools");

const document = () => composeComponent(componentTreeSchema.parse(buttonExample)).document;

test("partial MCP changes preserve layout, style, visibility and lock state", () => {
  expect(designNodeChangesSchema.parse({ text: "Longer label" })).toEqual({ text: "Longer label" });
  expect(designNodeChangesSchema.parse({ style: { fill: "#ffffff" } })).toEqual({
    style: { fill: "#ffffff" },
  });
});

test("exported TypeScript compiles in isolation and renders native controls with shared flow rules", async () => {
  const directory = await mkdtemp(resolve(import.meta.dir, "../../.export-test-"));
  try {
    const output = exportComponent(document(), "new-thread", "NewThread");
    for (const file of output.files) await writeFile(resolve(directory, file.path), file.content);
    await writeFile(
      resolve(directory, "Consumer.tsx"),
      `import { NewThread } from "./NewThread";
const valid = <NewThread variant="secondary" disabled onClick={() => {}} />;
// @ts-expect-error Unsupported names must be rejected by the public component API.
const invalid = <NewThread variant="unknown" />;
`,
    );
    expect(output.variants).toEqual(["primary", "secondary", "danger"]);
    const check = Bun.spawn(
      [
        "bun",
        "x",
        "--no-install",
        "tsc",
        "--noEmit",
        "--skipLibCheck",
        "--strict",
        "--jsx",
        "react-jsx",
        "--moduleResolution",
        "bundler",
        "--module",
        "esnext",
        "--target",
        "es2020",
        resolve(directory, "Consumer.tsx"),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const diagnostics =
      (await new Response(check.stdout).text()) + (await new Response(check.stderr).text());
    expect(await check.exited, diagnostics).toBe(0);
    const bundle = await Bun.build({
      entrypoints: [resolve(directory, "NewThread.tsx")],
      target: "bun",
      format: "esm",
      external: ["react", "react/jsx-runtime"],
    });
    expect(bundle.success).toBe(true);
    const file = resolve(directory, "component.mjs");
    await writeFile(file, await bundle.outputs[0].text());
    const { NewThread } = await import(file);
    const html = renderToStaticMarkup(createElement(NewThread));
    expect(html).toContain("<button");
    expect(html).toContain('type="button"');
    expect(html).toContain("display:flex");
    expect(html).toContain("align-items:center");
    expect(html).toContain("justify-content:center");
    expect(html).toContain("width:max-content");
    expect(html).toContain("New thread");
    const secondary = renderToStaticMarkup(createElement(NewThread, { variant: "secondary" }));
    const danger = renderToStaticMarkup(createElement(NewThread, { variant: "danger" }));
    expect(secondary).toContain("background:#eeeeec");
    expect(secondary).toContain("color:#282a28");
    expect(danger).toContain("background:#8f3030");
    expect(danger).toContain("color:#eeeeec");
    expect(secondary).not.toContain("variant=");
    expect(
      renderToStaticMarkup(
        createElement(NewThread, { disabled: true, "aria-label": "Create a thread" }),
      ),
    ).toContain('aria-label="Create a thread"');
    expect(codeRuntimeSource).not.toMatch(/from\s*["'](?:next|@\/|@bella)/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("exports only selected asset bytes and strips source paths and history", () => {
  const content = document();
  const id = "00000000-0000-4000-8000-000000000001";
  content.nodes.push({
    ...content.nodes[1],
    id: "icon",
    type: "vector",
    assetId: id,
    name: "Plus",
    semantics: { element: "span", hidden: true },
    text: undefined,
    widthMode: "fixed",
    heightMode: "fixed",
    box: { x: 0, y: 0, width: 16, height: 16 },
    sourcePath: "private/source.tsx",
  });
  content.editedNodeIds = ["label"];
  const result = exportComponent(content, "new-thread", "NewThread", [
    { id, mimeType: "image/svg+xml", base64: "PHN2Zy8+" },
  ]);
  expect(result.files.find((file) => file.encoding === "base64")).toMatchObject({
    path: `public/tidy-assets/${id}.svg`,
    content: "PHN2Zy8+",
  });
  expect(result.files[0].content).not.toContain("private/source.tsx");
  expect(() => exportComponent(content, "new-thread", "NewThread")).toThrow("missing");
  expect(() => exportComponent(content, "new-thread", "bad-name")).toThrow("PascalCase");
});

test("standalone component runtime carries the full licences of its copied dependencies", async () => {
  const result = exportComponent(document(), "new-thread", "NewThread");
  const runtime = result.files.find((file) => file.path === "tidy-runtime.js")!.content;
  for (const name of ["Paper.js", "Zod"]) {
    const license = await Bun.file(
      new URL(`../../../../licenses/bundled/${name}.txt`, import.meta.url),
    ).text();
    expect(runtime).toContain(license.trim());
  }
  expect(runtime).toContain("Tidy runtime code — Apache-2.0");
  expect(runtime).not.toContain("Meta Platforms"); // React is an external import here.
});

test("generated runtime stays in sync with the canvas render sources", async () => {
  const process = Bun.spawn(["bun", "apps/web/scripts/generate-code-runtime.ts", "--check"], {
    cwd: resolve(import.meta.dir, "../../../.."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const error = await new Response(process.stderr).text();
  expect(await process.exited, error).toBe(0);
});

test("exports prototype links outside the subtree and resolves app font aliases", () => {
  const content = document();
  content.nodes[0].linkTo = "next-frame";
  content.nodes[1].style.fontFamily = "var(--font-instrument-sans)";
  content.nodes.push({
    ...content.nodes[0],
    id: "next-frame",
    type: "artboard",
    linkTo: undefined,
    semantics: undefined,
    states: undefined,
    isComponent: undefined,
    variants: undefined,
    variant: undefined,
  });
  const result = exportComponent(content, "new-thread", "NewThread");
  expect(result.warnings.join("\n")).toContain("prototype");
  expect(result.files[0].content).not.toContain("var(--font-instrument-sans)");
  expect(result.files.find((file) => file.path.endsWith(".css"))?.content).toContain(
    "fonts.googleapis.com",
  );
});
