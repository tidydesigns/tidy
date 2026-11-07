import { expect, test } from "bun:test";
import { approvalText } from "./approval-text";

test("approval formatting distinguishes controls from literal escape notation", () => {
  expect(approvalText("visible\n\u001bhidden\u0007")).toBe("visible\n\\u001bhidden\\u0007");
  expect(approvalText("\\u001b")).toBe("\\\\u001b");
});

for (const limit of [240, 4000, 16_000]) {
  test(`approval text keeps complete character boundaries at ${limit}`, () => {
    const prefix = "a".repeat(limit - 1);
    expect(approvalText(prefix + "\u001b", limit)).toBe(prefix);
    expect(approvalText(prefix + "\\", limit)).toBe(prefix);
    expect(approvalText(prefix + "😀", limit)).toBe(prefix);
    const exact = "a".repeat(limit - 6) + "\u001b";
    expect(approvalText(exact, limit)).toBe("a".repeat(limit - 6) + "\\u001b");
    const literalPrefix = "a".repeat(limit - 2);
    expect(approvalText(literalPrefix + "\\u001b", limit)).toBe(literalPrefix + "\\\\");
  });
}
