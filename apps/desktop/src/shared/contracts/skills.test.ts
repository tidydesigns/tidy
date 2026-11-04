import { describe, expect, test } from "bun:test";
import { promptSkill, skillCommand, skillInvocationPrompt, skillQuery } from "./skills";

const review = { id: "current", name: "review", description: "Review changes" };
const remembered = { id: "outdated", name: "review" };

describe("prompt skill selection", () => {
  for (const prefix of ["/", "$"] as const) {
    test.each([
      `${prefix}review changes`,
      `Please use ${prefix}review on these changes`,
      `Use $HOME then ${prefix}review changes`,
      `👩🏽‍💻 检查\n${prefix}review\r\nSeán O'Brien`,
      `Before\t${prefix}review\tafter`,
    ])("prefers the current catalog id for %s", (text) => {
      expect(promptSkill(text, [review], remembered).skill).toBe(review);
      expect(promptSkill(text, [], remembered).skill).toBe(remembered);
      expect(promptSkill(text, [review]).skill).toBe(review);
      expect(promptSkill(text, [], undefined).skill).toBeUndefined();
    });
    test("keeps surrounding text when normalizing an inline invocation", () => {
      const text = `Please check\n${prefix}review changes\nwith 王秀英`;
      expect(skillInvocationPrompt(text, prefix, "review")).toBe(
        `${prefix}review Please check changes\nwith 王秀英`,
      );
      expect(skillInvocationPrompt(text, prefix, "missing")).toBe(text);
    });
  }
  test.each([
    "",
    "Plain text",
    "$HOME",
    "/tmp/review",
    "https://example.com/review",
    "${review}",
    "$(review)",
    "$$review",
    "/review.md",
    "`$review`",
  ])("does not attach a remembered skill to literal %s", (text) =>
    expect(promptSkill(text, [review], remembered).skill).toBeUndefined(),
  );
  test("uses prompt order and rejects a different remembered name", () => {
    const audit = { id: "audit", name: "audit", description: "" };
    expect(promptSkill("Use $audit then $review", [review, audit], remembered).skill).toBe(audit);
    expect(promptSkill("Use $audit", [], remembered).skill).toBeUndefined();
  });
  test("honors the maximum skill name and does not match longer names partially", () => {
    const name = `review-${"changes-".repeat(24)}x`;
    expect(name.length).toBe(200);
    expect(skillCommand(`Use $${name}`)?.name).toBe(name);
    expect(skillCommand(`Use $${name}x`)).toBeNull();
    expect(skillQuery(`Use $${name}`, 205)).toBe(name);
  });
});
