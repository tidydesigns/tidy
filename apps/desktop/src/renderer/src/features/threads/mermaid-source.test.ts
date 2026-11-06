import { describe, expect, test } from "bun:test";
import { mermaidSourceError } from "./mermaid-source";

describe("Mermaid preview input", () => {
  test("allows URL labels without treating them as external resources", () => {
    expect(
      mermaidSourceError(
        'flowchart LR\n A["https://example.com"] --> B@{ shape: rect, label: "Ready" }',
      ),
    ).toBeNull();
  });

  test("keeps empty and excessive diagrams out of automatic layout", () => {
    expect(mermaidSourceError(" \r\n\t")).toContain("empty");
    expect(mermaidSourceError("A".repeat(20_001))).toContain("too large");
    expect(mermaidSourceError("A".repeat(20_000))).toBeNull();
    const lines = ["flowchart TD", " A[Ready]", ...Array<string>(298).fill("%% comment")];
    for (const newline of ["\n", "\r\n"]) {
      expect(mermaidSourceError(lines.join(newline) + newline)).toBeNull();
      expect(mermaidSourceError([...lines, "%% over limit"].join(newline) + newline)).toContain(
        "too large",
      );
    }
  });

  test("blocks resource-loading constructs before the renderer is imported", () => {
    for (const source of [
      'flowchart TD\n A["<img src=x>"]',
      'flowchart TD\n A["![label](../image.png)"]',
      "flowchart TD\n A --> B\n classDef default fill:url(https://example.invalid/a.png)",
      String.raw`flowchart TD; A --> B; classDef default fill:u\72l(x)`,
      '%%{init:{"themeCSS":"@import url(https://example.invalid/a.css)"}}%%\nflowchart TD\n A --> B',
    ])
      expect(mermaidSourceError(source)).toContain("resources");
  });
});
