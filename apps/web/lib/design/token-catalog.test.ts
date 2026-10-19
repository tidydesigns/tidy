import { describe, expect, test } from "bun:test";
import { blankDesignDocument, buildDrawnNode, parseDesignDocument } from "./document";
import { mergeDesignTokens, putDesignToken } from "./token-catalog";
import { removeDesignToken, renameDesignToken } from "./tokens";
import { resolvedColorTokens } from "./design-tokens";

const layer = (id: string) => ({
  ...buildDrawnNode(id, "container", null, { x: 0, y: 0, width: 100, height: 50 }),
  style: { fill: "#123456" },
});

describe("token catalog", () => {
  test("legacy tokens keep their references when edited, renamed and removed", () => {
    const document = parseDesignDocument({
      ...blankDesignDocument(),
      tokens: { ink: "#123456" },
      designTokens: { text: { type: "color", alias: "ink" } },
      nodes: [{ ...layer("card"), style: { fillToken: "ink" } }],
    });
    const edited = putDesignToken(document, "ink", { type: "color", value: "#22735980" });
    expect(edited.tokens).toEqual({});
    expect(resolvedColorTokens(edited)).toEqual({ ink: "#22735980", text: "#22735980" });
    const renamed = renameDesignToken(edited, "ink", "brand");
    expect(renamed.nodes[0]?.style.fillToken).toBe("brand");
    expect(renamed.designTokens?.text).toEqual({ type: "color", alias: "brand" });
    const removed = removeDesignToken(renamed, "brand");
    expect(removed.nodes[0]?.style.fill).toBe("#22735980");
    expect(removed.nodes[0]?.style.fillToken).toBeUndefined();
    expect(resolvedColorTokens(removed).text).toBe("#22735980");
  });

  test("merges an agent palette without dropping existing definitions and rejects invalid alias graphs", () => {
    const document = parseDesignDocument({
      ...blankDesignDocument(),
      tokens: { ink: "#123456", paper: "#ffffff" },
      designTokens: { border: { type: "color", alias: "ink" } },
      nodes: [layer("card")],
    });
    const merged = mergeDesignTokens(document, {
      ink: { type: "color", value: "#22735980" },
      accent: { type: "color", value: "#aabbcc" },
    });
    expect(merged.tokens).toEqual({ paper: "#ffffff" });
    expect(resolvedColorTokens(merged)).toEqual({
      paper: "#ffffff",
      ink: "#22735980",
      border: "#22735980",
      accent: "#aabbcc",
    });
    expect(() =>
      mergeDesignTokens(document, {
        ink: { type: "color", alias: "border" },
      }),
    ).toThrow();
    expect(document.tokens.ink).toBe("#123456");
    expect(document.designTokens?.accent).toBeUndefined();
  });
});
