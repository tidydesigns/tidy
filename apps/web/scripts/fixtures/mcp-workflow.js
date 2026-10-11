// Run in the T3 browser on the local apps/site homepage after starting the
// disposable MCP_WORKFLOW fixture. No remote Tidy server is used.
globalThis.runTidyMcpWorkflow = async function () {
  const base = "http://127.0.0.1:4319";
  const call = async (name, args = {}) => {
    const message = await (
      await fetch(`${base}/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, arguments: args }),
      })
    ).json();
    if (message.error || message.result?.isError) throw new Error(JSON.stringify(message));
    return message.result.structuredContent;
  };
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const start = performance.now();
  await call("get_import_guidance");
  const script = await call("get_browser_capture_script");
  (0, eval)(script.script);
  const viewport = await globalThis.__tidyCapture.prepare({ selector: ".page" });
  // This source has no screenshot-dependent effects. Capture warnings remain
  // visible; screenshot fallback cases are outside this particular fixture.
  const capture = await globalThis.__tidyCapture.capture({ selector: ".page", viewport });
  const imported = await call("import_web_capture", { organization_id: "org-a", capture });
  const saved = (await call("get_document", { file_id: imported.fileId })).document;
  check(saved.content.nodes[0].style.fill === "#f2f2f0", "Page background lost");
  check(
    saved.content.nodes.some(
      (n) => n.style.borderBottomWidth === 4 && n.style.borderColor === "#ff5d00",
    ),
    "Link underline lost",
  );
  const logo = document.querySelector(".tidy-logo").getBoundingClientRect();
  // Resolve this codebase's private Next font aliases to their actual families.
  // The server's local font-provider fixture embeds the exact checked-in WOFF2s.
  const edits = saved.content.nodes
    .filter((n) => n.type === "text")
    .map((n) => ({
      node_id: n.id,
      changes: {
        ...(n.text === "Tidy" ? { box: { y: logo.y, height: logo.height } } : {}),
        style: {
          fontFamily: n.style.fontFamily.startsWith("instrumentSerif")
            ? "Instrument Serif"
            : "Instrument Sans",
          fontSource: "web",
        },
      },
    }));
  const patched = await call("patch_document", {
    file_id: imported.fileId,
    expected_revision: saved.revision,
    ...edits[0],
    additional_edits: edits.slice(1),
    include_document: false,
  });
  const website = await call("export_visual_preview", {
    file_id: imported.fileId,
    selections: [{ node_id: imported.nodeIds[0], label: "Tidy website — measured capture" }],
  });
  check(!website.warnings.length, "Unexpected website rendering warnings");
  const websiteMs = performance.now() - start;

  const guidance = await call("get_design_guidance");
  let design = (await call("compose_component", { tree: guidance.buttonExample })).document;
  for (const variant of ["secondary", "danger"])
    design = (
      await call("instantiate_component", {
        document: design,
        component_id: "new-thread",
        instance_id: variant,
        variant,
      })
    ).document;
  const staging = await call("create_import", {
    organization_id: "org-a",
    name: "Tidy — verified component variations",
  });
  await call("put_import_chunk", {
    import_id: staging.importId,
    chunk_id: "0000",
    nodes: design.nodes,
    source: { project: "tidy-codebase", route: "mcp/buttonExample" },
    warnings: [],
  });
  const validation = await call("validate_import", { import_id: staging.importId });
  check(validation.layout.valid, "Invalid component layout");
  const committed = await call("commit_import", { import_id: staging.importId });
  await call("patch_document", {
    file_id: committed.fileId,
    expected_revision: committed.revision,
    node_id: "new-thread",
    changes: { style: { radius: 12 }, paddingLeft: 24, paddingRight: 24 },
    additional_edits: [{ node_id: "label", changes: { text: "Create design" } }],
    include_document: false,
  });
  const read = (await call("get_document", { file_id: committed.fileId })).document;
  check(read.revision === committed.revision + 1, "Batch changed revision more than once");
  check(
    read.content.nodes.filter((n) => n.type === "text").every((n) => n.text === "Create design"),
    "Component inheritance lost",
  );
  const variants = await call("export_visual_preview", {
    file_id: committed.fileId,
    selections: [
      { node_id: "new-thread", label: "Primary" },
      { node_id: "secondary", label: "Secondary" },
      { node_id: "danger", label: "Danger" },
    ],
  });
  check(!variants.warnings.length, "Unexpected component rendering warnings");
  return {
    viewport,
    websiteMs,
    totalMs: performance.now() - start,
    editableText: edits.length,
    nodeCount: saved.content.nodes.length,
    captureWarnings: capture.document.warnings,
    website: {
      fileId: imported.fileId,
      revision: patched.revision,
      url: website.fixturePreviewUrl,
    },
    variants: {
      fileId: committed.fileId,
      revision: read.revision,
      url: variants.fixturePreviewUrl,
    },
  };
};
