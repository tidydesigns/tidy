import { expect, test } from "bun:test";
import { buildDrawnNode } from "./document";
import { textToolStyle } from "./text-tool-style";

test("remembered text styling carries typography without geometry or visual effects", () => {
  const node = buildDrawnNode("heading", "text", null, { x: 20, y: 30, width: 300, height: 80 });
  node.style = {
    fontSize: 48,
    fontFamily: "Inter",
    fontWeight: 700,
    lineHeightMode: "px",
    lineHeightPx: 54,
    color: "#123456",
    rotation: 90,
    opacity: 0.2,
    shadow: "0 4px 8px #000000",
    colorToken: "brand",
    overflow: "hidden",
  };
  const remembered = textToolStyle(node);
  expect(remembered).toMatchObject({
    fontSize: 48,
    fontFamily: "Inter",
    fontWeight: 700,
    lineHeightMode: "px",
    lineHeightPx: 54,
    color: "#123456",
  });
  for (const key of ["rotation", "opacity", "shadow", "colorToken", "overflow"])
    expect(remembered).not.toHaveProperty(key);
});

test("missing typography gets valid defaults without discarding legacy line height", () => {
  const remembered = textToolStyle({ style: { lineHeight: 1.5 } });
  expect(remembered).toMatchObject({
    fontSize: 16,
    fontWeight: 400,
    color: "#1e1e1e",
    lineHeight: 1.5,
  });
  expect(remembered.lineHeightMode).toBeUndefined();
});
