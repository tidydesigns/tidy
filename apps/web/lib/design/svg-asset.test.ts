import { expect, test } from "bun:test";
import { DOMParser } from "@xmldom/xmldom";
import { sanitizeSvgAsset } from "./svg-asset";

const namespace = "http://www.w3.org/2000/svg";
test("static SVG normalization preserves geometry, text, gradients and local references", () => {
  const output =
    sanitizeSvgAsset(`<s:svg xmlns:s="${namespace}" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 20 20">
    <s:defs><s:linearGradient id="paint"><s:stop offset="0" stop-color="#fff"/></s:linearGradient>
      <s:path id="shape" d="M0 0L20 20"/></s:defs>
    <s:use xlink:href="#shape" fill="url(#paint)"/>
    <s:text x="1" y="2" style="font-weight:600;fill:#123">A &amp; B</s:text>
  </s:svg>`);
  expect(output).toContain('viewBox="0 0 20 20"');
  expect(output).toContain('d="M0 0L20 20"');
  expect(output).toContain('href="#shape"');
  expect(output).toContain('fill="url(#paint)"');
  expect(output).toContain("A &amp; B");
  expect(sanitizeSvgAsset(output)).toBe(output);
});

test("SVG validation handles namespaces, decoded attributes and document structure", () => {
  for (const source of [
    `<svg xmlns="${namespace}"><s:script xmlns:s="${namespace}">void 0</s:script></svg>`,
    `<svg xmlns="${namespace}"><f:foreignObject xmlns:f="${namespace}"/></svg>`,
    `<svg xmlns="${namespace}"><g xmlns="http://www.w3.org/1999/xhtml"/></svg>`,
    '<svg><use href="&#104;ttps://example.test/image"/></svg>',
    '<svg><rect onload="void 0"/></svg>',
    '<svg><animate attributeName="href" values="#one;#two"/></svg>',
    "<svg><style>rect{fill:u<!-- split -->rl(https://example.test/image)}</style></svg>",
    "<svg><style>rect{fill:u\\72l(https://example.test/image)}</style></svg>",
    '<svg><rect style="fill:url(https://example.test/image)"/></svg>',
    '<svg><style>@import "https://example.test/style";</style></svg>',
    '<!DOCTYPE svg [<!ENTITY value "content">]><svg/>',
    '<?xml-stylesheet href="https://example.test/style"?><svg/>',
    "<svg/><svg/>",
    "<svg><g></svg>",
    '<svg width="1" width="2"/>',
    "<svg>" + "<g>".repeat(130) + "</g>".repeat(130) + "</svg>",
  ])
    expect(() => sanitizeSvgAsset(source)).toThrow();
});

test("SVG text and metadata cannot become markup during serialization", () => {
  const output = sanitizeSvgAsset(
    "<svg><text><![CDATA[<script>literal</script>]]></text><!-- omitted --></svg>",
  );
  expect(output).toContain("&lt;script&gt;literal&lt;/script&gt;");
  expect(output).not.toContain("<!--");
});

test("decoded SVG attributes and text retain literal markup after serialization", () => {
  const literal = '<script title="quoted">A & B</script>';
  const source = `<svg aria-label="&lt;script title=&quot;quoted&quot;&gt;A &amp; B&lt;/script&gt;">
    <text><![CDATA[${literal}]]></text>
    <style><![CDATA[text::after{content:"<svg onload='alert(1)'>"}]]></style>
  </svg>`;
  const output = sanitizeSvgAsset(source);
  expect(output).not.toContain("<script");
  expect(output).not.toContain("<svg onload");
  const parsed = new DOMParser().parseFromString(output, "image/svg+xml");
  expect(parsed.documentElement.getAttribute("aria-label")).toBe(literal);
  expect(parsed.getElementsByTagName("text")[0].textContent).toBe(literal);
  expect(parsed.getElementsByTagName("style")[0].textContent).toBe(
    `text::after{content:"<svg onload='alert(1)'>"}`,
  );
  expect(parsed.getElementsByTagName("script").length).toBe(0);
  expect(sanitizeSvgAsset(output)).toBe(output);
});

test("SVG attribute escaping preserves entity-encoded whitespace and delimiters", () => {
  const output = sanitizeSvgAsset('<svg aria-label="&quot;&amp;&lt;&gt;&#9;&#10;&#13;"/>');
  const parsed = new DOMParser().parseFromString(output, "image/svg+xml");
  expect(parsed.documentElement.getAttribute("aria-label")).toBe('"&<>\t\n\r');
  expect(sanitizeSvgAsset(output)).toBe(output);
});

test("normalization deduplicates local reference aliases and omits empty comments", () => {
  const source =
    '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><use href="#a" xlink:href="#b"/><!-- ignored --></svg>';
  const output = sanitizeSvgAsset(source);
  expect(output).toContain('<use href="#b"/>');
  expect(sanitizeSvgAsset(output)).toBe(output);
  expect(sanitizeSvgAsset("<svg><!-- ignored --></svg>")).toBe(sanitizeSvgAsset("<svg/>"));
});
