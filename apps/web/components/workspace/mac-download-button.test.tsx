import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MacDownloadButton, type MacDownloadVariant } from "./mac-download-button";

test("the sidebar default links to the site's permanent Mac download endpoint", () => {
  const html = renderToStaticMarkup(<MacDownloadButton />);
  const href = html.match(/href="([^"]+)"/)?.[1];
  const site = new URL(process.env.NEXT_PUBLIC_SITE_URL || "https://tidydesign.co");
  expect(href).toBe(new URL("/download/mac", site).href);
  expect(html).toContain('data-download-variant="cloud-light"');
  expect(html).toContain("<a ");
  expect(html).not.toContain("<button");
  // The site resolves the current release; the client must not pin a release or prefetch it.
  expect(html).not.toContain("releases/download");
  expect(html).not.toContain('rel="prefetch"');
  expect(html).not.toContain("download=");
});

test("all three variants retain the visible download label, Beta, and decorative Apple mark", () => {
  const variants: MacDownloadVariant[] = ["cloud-light", "spectrum-glint", "prism-edge"];
  for (const variant of variants) {
    const html = renderToStaticMarkup(<MacDownloadButton variant={variant} />);
    expect(html).toContain(`data-download-variant="${variant}"`);
    expect(html).toContain("Download for Mac");
    expect(html).toContain(">Beta</span>");
    expect(html).toMatch(/<svg[^>]+aria-hidden="true"/);
  }
});

test("the loading shell can remove the duplicate visual link from keyboard navigation", () => {
  const html = renderToStaticMarkup(<MacDownloadButton tabIndex={-1} />);
  expect(html).toContain('tabindex="-1"');
});

test("sidebar activations track once without delaying navigation or counting previews", () => {
  // Keep module mocks and browser state out of other tests.
  const result = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
      import { mock } from "bun:test";
      import assert from "node:assert/strict";
      let analytics = true, fail = false;
      const calls = [];
      mock.module("./lib/privacy/consent", () => ({browserConsent: () => ({analytics})}));
      mock.module("./lib/posthog-client", () => ({default: {capture(...args) {
        if (fail) throw new Error("synthetic failure");
        calls.push(args);
      }}}));
      const { MacDownloadButton } = await import("./components/workspace/mac-download-button");
      const event = (button = 0) => ({button, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; }});
      for (const variant of ["cloud-light", "spectrum-glint", "prism-edge"]) {
        const link = MacDownloadButton({variant, analyticsSource: "web_sidebar"});
        const click = event();
        const before = calls.length;
        link.props.onClick(click);
        assert.equal(click.defaultPrevented, false);
        assert.equal(calls.length, before + 1);
        assert.deepEqual(calls.at(-1), ["desktop_download_clicked",
          {source: "web_sidebar", variant, platform: "macos", channel: "beta"},
          {send_instantly: true}]);
      }
      const link = MacDownloadButton({analyticsSource: "web_sidebar"});
      let count = calls.length;
      link.props.onAuxClick(event(1));
      assert.equal(calls.length, ++count);
      link.props.onAuxClick(event(2));
      assert.equal(calls.length, count);
      MacDownloadButton({}).props.onClick(event());
      MacDownloadButton({tabIndex: -1}).props.onClick(event());
      MacDownloadButton({analyticsSource: "web_sidebar", onClick: e => e.preventDefault()})
        .props.onClick(event());
      assert.equal(calls.length, count);
      analytics = false;
      link.props.onClick(event());
      assert.equal(calls.length, count);
      analytics = true; fail = true;
      const click = event();
      assert.doesNotThrow(() => link.props.onClick(click));
      assert.equal(click.defaultPrevented, false);
      `,
    ],
    { cwd: import.meta.dir + "/../..", stdout: "pipe", stderr: "pipe" },
  );
  expect(new TextDecoder().decode(result.stderr)).toBe("");
  expect(result.exitCode).toBe(0);
});
