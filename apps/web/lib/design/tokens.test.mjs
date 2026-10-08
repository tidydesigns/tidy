import { expect, test } from "bun:test";
import { blankDesignDocument, buildDrawnNode } from "./document";
import { renameColorToken, removeColorToken } from "./tokens";
import { nodeStyle } from "./node-style";

const fixture = () => ({
  ...blankDesignDocument(),
  tokens: { brand: "#ff000080" },
  nodes: [
    {
      ...buildDrawnNode("one", "container", null, { x: 0, y: 0, width: 100, height: 50 }),
      style: { fillToken: "brand", colorToken: "brand", borderColorToken: "brand", borderWidth: 1 },
    },
  ],
});

test("renaming a token preserves every color binding and rendered appearance", () => {
  const document = renameColorToken(fixture(), "brand", "accent");
  expect(document.tokens).toEqual({ accent: "#ff000080" });
  expect(document.nodes[0].style).toMatchObject({
    fillToken: "accent",
    colorToken: "accent",
    borderColorToken: "accent",
  });
  expect(nodeStyle(document.nodes[0], "absolute", document.tokens).background).toBe("#ff000080");
});

test("removing a token leaves its current color on each bound property", () => {
  const document = removeColorToken(fixture(), "brand");
  expect(document.tokens).toEqual({});
  expect(document.nodes[0].style).toMatchObject({
    fill: "#ff000080",
    color: "#ff000080",
    borderColor: "#ff000080",
  });
  expect(document.nodes[0].style.fillToken).toBeUndefined();
});

test("token renaming rejects invalid or occupied names", () => {
  expect(() => renameColorToken(fixture(), "brand", "bad name")).toThrow();
  expect(() =>
    renameColorToken(
      { ...fixture(), tokens: { ...fixture().tokens, accent: "#000000" } },
      "brand",
      "accent",
    ),
  ).toThrow("already exists");
});
