import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { blankDesignDocument, buildDrawnNode, parseDesignDocument } from "./document";
import { vectorCompositeStyle } from "@tidy/design-renderer/vector-composites";
import { TidyDesign } from "@tidy/design-renderer/design";

const assetId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
function fixture() {
  const group = buildDrawnNode("mask", "container", null, { x: 0, y: 0, width: 100, height: 100 });
  group.mask = { sourceId: "source", mode: "alpha", enabled: true };
  const source = buildDrawnNode("source", "container", "mask", {
    x: 0,
    y: 0,
    width: 100,
    height: 100,
  });
  source.style = {
    opacity: 0.8,
    paints: [
      {
        id: "image",
        type: "image",
        assetId,
        intrinsicSize: { width: 200, height: 100 },
        fit: "cover",
        positionX: 50,
        positionY: 50,
        visible: true,
        opacity: 0.5,
      },
    ],
  };
  const content = buildDrawnNode("red", "container", "mask", {
    x: 0,
    y: 0,
    width: 100,
    height: 100,
  });
  return parseDesignDocument({ ...blankDesignDocument(), nodes: [group, source, content] });
}

test("image-mask cover geometry and opacity follow edits to the source", () => {
  const document = fixture(),
    [group, source] = document.nodes;
  const styles = () =>
    vectorCompositeStyle(group, document.nodes, {}, undefined, {
      [assetId]: "data:image/png;base64,AA==",
    });
  expect(styles()).toMatchObject({
    opacity: 0.4,
    maskSize: "200px 100px, 100px 100px",
    maskPosition: "-50px 0px, 0px 0px",
    maskComposite: "intersect",
  });
  source.box = { x: 10, y: 30, width: 50, height: 100 };
  expect(styles()).toMatchObject({
    maskSize: "200px 100px, 50px 100px",
    maskPosition: "-65px 30px, 10px 30px",
  });
  source.visible = false;
  expect(styles().opacity).toBe(0);
});

test("image-mask fit, luminance and missing assets use bounded native CSS", () => {
  const document = fixture(),
    [group, source] = document.nodes;
  group.mask!.mode = "luminance";
  const paint = source.style.paints![0];
  if (paint.type !== "image") throw new Error("Missing test image");
  paint.fit = "contain";
  expect(
    vectorCompositeStyle(group, document.nodes, {}, undefined, () => "blob:fixture"),
  ).toMatchObject({
    maskSize: "100px 50px, 100px 100px",
    maskPosition: "0px 25px, 0px 0px",
    maskMode: "luminance, alpha",
  });
  expect(vectorCompositeStyle(group, document.nodes, {}).opacity).toBe(0);
  expect(vectorCompositeStyle(source, document.nodes, {}, group)).toMatchObject({
    opacity: 0,
    pointerEvents: "none",
  });
});

test("shared exports keep image-mask assets and validated intrinsic dimensions", () => {
  const document = fixture();
  const markup = renderToStaticMarkup(
    <TidyDesign
      document={document}
      rootId="mask"
      assets={{ [assetId]: "data:image/png;base64,AA==" }}
    />,
  );
  expect(markup).toContain("mask-image:url(&quot;data:image/png;base64,AA==&quot;)");
  expect(markup).toContain("mask-composite:intersect");
  expect(parseDesignDocument(JSON.parse(JSON.stringify(document)))).toEqual(document);
  document.nodes[1].style.rotation = 30;
  expect(() => parseDesignDocument(document)).toThrow("supported source");
});
