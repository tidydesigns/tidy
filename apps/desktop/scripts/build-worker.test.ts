import { expect, test } from "bun:test";
import { blankDesignDocument } from "@tidy/design/document";
import { fileURLToPath } from "node:url";

test("the embedded compute worker validates designs and renders markup in Node", async () => {
  const document = blankDesignDocument();
  document.nodes.push({
    id: "frame",
    parentId: null,
    pageId: document.pages[0].id,
    type: "artboard",
    name: "Frame",
    visible: true,
    locked: false,
    box: { x: 0, y: 0, width: 320, height: 180 },
    layout: "absolute",
    style: { fill: "#ffffff" },
  });
  const build = Bun.spawn(
    [
      process.execPath,
      "--eval",
      'import { bundledComputeWorker } from "./scripts/build-worker.ts"; console.log(await bundledComputeWorker());',
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [source, buildError, buildCode] = await Promise.all([
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
    build.exited,
  ]);
  expect(buildError).toBe("");
  expect(buildCode).toBe(0);
  const script = `
    import { Worker } from "node:worker_threads";
    import { once } from "node:events";
    const worker = new Worker(new URL(${JSON.stringify(source.trim())}));
    const deadline = setTimeout(() => { worker.terminate(); process.exitCode = 1; }, 10_000);
    try {
      const document = ${JSON.stringify(document)};
      const encoded = once(worker, "message");
      worker.postMessage({id: 1, kind: "encode-design", design: { id: "design", name: "Design", folderId: null, document }});
      const [encoding] = await encoded;
      if (encoding.error) throw new Error(encoding.error);
      const parsed = JSON.parse(Buffer.from(encoding.value).toString("utf8"));
      const rendered = once(worker, "message");
      worker.postMessage({id: 2, kind: "render-markup", snapshot: { document: parsed.document, rootId: "frame", assets: {}, width: 320 }});
      const [rendering] = await rendered;
      if (rendering.error) throw new Error(rendering.error);
      console.log(JSON.stringify({ name: parsed.document.nodes[0].name, markup: rendering.value }));
    } finally { clearTimeout(deadline); await worker.terminate(); }
  `;
  const child = Bun.spawn(["node", "--input-type=module"], {
    stdin: new Blob([script]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(error).toBe("");
  expect(code).toBe(0);
  expect(output).toContain('"name":"Frame"');
  expect(output).toContain("width:320px");
  expect(output).toContain("height:180px");
}, 20_000);
