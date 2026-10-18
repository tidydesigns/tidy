import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { blankDesignDocument, buildDrawnNode, type DesignNode } from "@tidy/design/document";
import { TidyDesign } from "@tidy/design-renderer/design";

function node(id: string, parentId: string | null = null, text?: string): DesignNode {
  return {
    ...buildDrawnNode(id, text === undefined ? "container" : "text", parentId, {
      x: 0,
      y: 0,
      width: 200,
      height: 40,
    }),
    ...(text === undefined ? {} : { text }),
  };
}

function render(nodes: DesignNode[], props: Partial<Parameters<typeof TidyDesign>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(TidyDesign, {
      document: { ...blankDesignDocument(), nodes },
      rootId: nodes[0].id,
      assets: {},
      onTrigger: () => false,
      ...props,
    }),
  );
}

function openingTag(html: string, tag: string) {
  const match = html.match(new RegExp(`<${tag}\\b[^>]*>`));
  expect(match, `Expected a rendered ${tag} element`).not.toBeNull();
  return match![0];
}

test("prototype buttons and links keep their visible content as the accessible name", () => {
  const root = {
    ...node("button"),
    name: "Primary CTA",
    semantics: { element: "button" as const },
  };
  const text = node("label", root.id, "Continue");
  const button = render([root, text]);
  const buttonTag = openingTag(button, "button");
  expect(button).toContain("Continue");
  expect(buttonTag).not.toContain("aria-label=");
  const link = render([{ ...root, semantics: { element: "a", href: "/continue" } }, text]);
  const linkTag = openingTag(link, "a");
  expect(linkTag).toContain('href="/continue"');
  expect(link).toContain("Continue");
  expect(linkTag).not.toContain("aria-label=");
  expect(linkTag).not.toContain('role="button"');
  expect(linkTag).not.toContain("tabindex=");
});

test("explicit author and host labels survive, with fallback only for unnamed controls", () => {
  const root = {
    ...node("button"),
    name: "Primary CTA",
    semantics: { element: "button" as const },
  };
  expect(openingTag(render([root]), "button")).toContain('aria-label="Primary CTA"');
  expect(
    openingTag(
      render([
        { ...root, semantics: { element: "button", label: "Continue checkout" } },
        node("text", root.id, "Continue"),
      ]),
      "button",
    ),
  ).toContain('aria-label="Continue checkout"');
  expect(
    openingTag(render([root], { rootProps: { "aria-label": "Host action" } }), "button"),
  ).toContain('aria-label="Host action"');
  const labelled = openingTag(
    render([root], { rootProps: { "aria-labelledby": "host-label" } }),
    "button",
  );
  expect(labelled).toContain('aria-labelledby="host-label"');
  expect(labelled).not.toContain("aria-label=");
  const titled = openingTag(
    render([root], { rootProps: { title: "Continue checkout" } }),
    "button",
  );
  expect(titled).toContain('title="Continue checkout"');
  expect(titled).not.toContain("aria-label=");
  const replaced = render([root, node("text", root.id, "Continue")], { text: { text: "" } });
  expect(openingTag(replaced, "button")).toContain('aria-label="Primary CTA"');
});

test("semantically hidden containers retain their rendering and make the whole subtree inert", () => {
  const root = { ...node("hidden"), semantics: { element: "div" as const, hidden: true } };
  const button = { ...node("child", root.id), semantics: { element: "button" as const } };
  const html = render([root, button, node("label", button.id, "Continue")]);
  const container = openingTag(html, "div");
  expect(container).toContain('aria-hidden="true"');
  expect(container).toContain('inert=""');
  expect(html).toContain("<button");
  expect(html).toContain("Continue");
  expect(html).not.toContain("display:none");
});

test("hover prototype controls are keyboard reachable without duplicating native semantics", () => {
  const interaction: NonNullable<DesignNode["interactions"]>[number] = {
    id: "00000000-0000-4000-8000-000000000001",
    trigger: { type: "hover" },
    action: { type: "back" },
    transition: { type: "instant", duration: 0 },
  };
  const root = { ...node("hover"), interactions: [interaction] };
  const custom = openingTag(render([root, node("text", root.id, "Show details")]), "div");
  expect(custom).toContain('role="button"');
  expect(custom).toContain('tabindex="0"');
  const button = openingTag(
    render([{ ...root, semantics: { element: "button" } }, node("text", root.id, "Show details")]),
    "button",
  );
  expect(button).not.toContain('role="button"');
  expect(button).not.toContain("tabindex=");
});

test("image descriptions use authored semantics in ordinary, vector and cropped renderings", () => {
  const image = {
    ...node("image"),
    name: "IMG_1234",
    assetId: "asset",
    semantics: { element: "div" as const, label: "Sunset over the sea" },
  };
  const standard = render([image], { assets: { asset: "https://example.test/photo.png" } });
  expect(openingTag(standard, "img")).toContain('alt="Sunset over the sea"');
  const vector = render([
    {
      ...image,
      assetId: undefined,
      vectorPath: {
        d: "M0 0L100 0L0 100Z",
        viewBox: { x: 0, y: 0, width: 100, height: 100 },
        fillRule: "nonzero",
      },
    },
  ]);
  expect(openingTag(vector, "img")).toContain('alt="Sunset over the sea"');
  const crop = render(
    [
      {
        ...image,
        style: {
          imageCrop: { x: 0, y: 0, width: 0.5, height: 0.5, sourceWidth: 400, sourceHeight: 400 },
        },
      },
    ],
    { assets: { asset: "https://example.test/photo.png" } },
  );
  const croppedImage = openingTag(crop, "svg");
  expect(croppedImage).toContain('role="img"');
  expect(croppedImage).toContain('aria-label="Sunset over the sea"');
});
