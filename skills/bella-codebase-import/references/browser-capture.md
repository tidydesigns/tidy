# Capture with the user's browser harness

`get_browser_capture_script` returns a self-contained `script` plus instructions. Run that script in the source page with the harness's JavaScript facility. It installs `globalThis.__tidyCapture`. No extension, repository access or server browser is needed. Use the browser the agent is authorized to operate; this recipe does not expand browser permissions.

The browser needs to support page JavaScript, PNG viewport screenshots, and passing binary/base64 data between harness calls. A screenshot-only browser cannot perform measured DOM capture. If those capabilities are unavailable, report the limitation instead of claiming a verified import.

For a Playwright-capable harness, with an authorized MCP client `mcp` and an existing `sourcePage`:

```js
const tool = await mcp.callTool({ name: "get_browser_capture_script", arguments: {} });
const { script } = tool.structuredContent;
await sourcePage.addScriptTag({ content: script });

// Set the requested viewport/state first. Pause animation consistently if needed.
// Choose a selector for a hero/component, or omit it for the full document.
const selector = ".hero";
const viewport = await sourcePage.evaluate(
  (selector) => globalThis.__tidyCapture.prepare({ selector }),
  selector,
);
const png = await sourcePage.screenshot({ fullPage: false });
const capture = await sourcePage.evaluate((options) => globalThis.__tidyCapture.capture(options), {
  selector,
  viewport,
  screenshot: `data:image/png;base64,${png.toString("base64")}`,
});

const imported = await mcp.callTool({
  name: "import_web_capture",
  arguments: { organization_id: organizationId, capture },
});
if (imported.isError) throw new Error(imported.content[0].text);
```

Do not change the tab, URL, viewport, scroll position or animation state between preparation, screenshot and capture. Use a viewport screenshot, not a full-page image: crop coordinates are viewport pixels. A selected perspective group must be visible in full; enlarge the viewport or choose a smaller group before capturing. Never send private form values; capture redacts form controls from screenshot fallbacks. Inspect warnings before publishing.

Keep the script, screenshot and returned asset bytes in harness variables or local artifacts. Avoid echoing megabytes into the conversation. `import_web_capture` accepts at most 16 MB and appends a new copy on **every** invocation. For smaller client message limits, upload each asset via `put_asset`, replace capture-local asset IDs in nodes and image paints with uploaded IDs, then send nodes through `create_import`, `put_import_chunk`, `validate_import`, `commit_import`. Retry an uncertain staged commit with its original import ID. For an uncertain `import_web_capture` result, inspect the destination before retrying.

After publishing, read `get_document` to verify structure and revision, then open the returned file URL in the agent's browser. Compare the artboard at the source's viewport and 100% scale (or matched scale crops). Check gradients, transforms, icons, text wrapping and stacking. The actual imported canvas—not the capture JSON—is the visual validation target. Fix remaining discrepancies and recheck. Report the file link, viewport/state, flattened or omitted groups, redactions, and what was visually verified. If the harness cannot open the imported canvas, explicitly report that visual verification is incomplete.
