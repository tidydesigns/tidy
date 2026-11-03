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
