import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { blankDesignDocument, buildDrawnNode, type DesignNode } from "@bella/design/document";
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

test("prototype buttons and links keep their visible content as the accessible name", () => {
  const root = {
    ...node("button"),
    name: "Primary CTA",
    semantics: { element: "button" as const },
  };
  const text = node("label", root.id, "Continue");
  const button = render([root, text]);
  expect(button).toContain("<button");
  expect(button).toContain("Continue");
  expect(button).not.toContain("aria-label=");
  const link = render([{ ...root, semantics: { element: "a", href: "/continue" } }, text]);
  expect(link).toContain('href="/continue"');
  expect(link).not.toContain("aria-label=");
  expect(link).not.toContain('role="button"');
  expect(link).not.toContain("tabindex=");
});

test("explicit author and host labels survive, with fallback only for unnamed controls", () => {
  const root = {
    ...node("button"),
    name: "Primary CTA",
    semantics: { element: "button" as const },
  };
  expect(render([root])).toContain('aria-label="Primary CTA"');
  expect(
    render([
      { ...root, semantics: { element: "button", label: "Continue checkout" } },
      node("text", root.id, "Continue"),
    ]),
  ).toContain('aria-label="Continue checkout"');
  expect(render([root], { rootProps: { "aria-label": "Host action" } })).toContain(
    'aria-label="Host action"',
  );
  const labelled = render([root], { rootProps: { "aria-labelledby": "host-label" } });
  expect(labelled).toContain('aria-labelledby="host-label"');
  expect(labelled).not.toContain("aria-label=");
  const titled = render([root], { rootProps: { title: "Continue checkout" } });
  expect(titled).toContain('title="Continue checkout"');
  expect(titled).not.toContain("aria-label=");
  const replaced = render([root, node("text", root.id, "Continue")], { text: { text: "" } });
  expect(replaced).toContain('aria-label="Primary CTA"');
});

test("semantically hidden containers retain their rendering and make the whole subtree inert", () => {
  const root = { ...node("hidden"), semantics: { element: "div" as const, hidden: true } };
  const button = { ...node("child", root.id), semantics: { element: "button" as const } };
  const html = render([root, button, node("label", button.id, "Continue")]);
  expect(html).toContain('aria-hidden="true" inert=""');
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
  expect(render([root, node("text", root.id, "Show details")])).toContain(
    'role="button" tabindex="0"',
  );
  const button = render([
    { ...root, semantics: { element: "button" } },
    node("text", root.id, "Show details"),
  ]);
  expect(button).toContain("<button");
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
  expect(standard).toContain('alt="Sunset over the sea"');
  expect(standard).not.toContain('alt="IMG_1234"');
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
  expect(vector).toContain('alt="Sunset over the sea"');
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
  expect(crop).toContain('role="img" aria-label="Sunset over the sea"');
});
