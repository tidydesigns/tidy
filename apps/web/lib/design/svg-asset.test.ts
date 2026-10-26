import { expect, test } from "bun:test";
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
