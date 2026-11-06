import { describe, expect, test } from "bun:test";
import {
  promptSkill,
  matchingSkills,
  skillCommand,
  skillCommands,
  skillInvocationPrompt,
  skillQuery,
  skillSelectionSchema,
} from "./skills";

const review = { id: "current", name: "review", description: "Review changes" };
const remembered = { id: "outdated", name: "review" };

describe("skill query and matching", () => {
  test.each(["/", "$"])("offers skills at any whitespace-delimited %s token", (prefix) => {
    expect(skillQuery(prefix, 1)).toBe("");
    expect(skillQuery(`${prefix}rev`, 4)).toBe("rev");
    expect(skillQuery(`${prefix}REV`, 4)).toBe("rev");
    expect(skillQuery(`${prefix}rev existing text`, 4)).toBe("rev");
    for (const text of [
      `${prefix}tmp/file`,
      "https://site",
      `${prefix}review changes`,
      "`" + prefix + "review`",
      "${review}",
      "$(review)",
      "$$review",
    ])
      expect(skillQuery(text, text.length)).toBeNull();
    expect(skillQuery(`${prefix}review`, 3)).toBeNull();
    expect(skillQuery(`look ${prefix}review`, 12)).toBe("review");
    expect(skillQuery(`\n${prefix}review`, 8)).toBe("review");
    expect(skillQuery(`Use ${prefix}`, 5)).toBe("");
    expect(skillQuery(`Use ${prefix}rev later`, 8)).toBe("rev");
  });
  test.each(["/", "$"])("parses inline %s commands and keeps paths literal", (prefix) => {
    expect(skillCommand(`${prefix}review these changes`)).toEqual({
      name: "review",
      start: 0,
      end: 7,
    });
    expect(skillCommand(`run ${prefix}review changes`)).toEqual({
      name: "review",
      start: 4,
      end: 11,
    });
    expect(skillCommand(`Use $HOME then ${prefix}review changes`, ["review"])?.name).toBe("review");
    expect(skillCommand(`Use $HOME then ${prefix}review changes`, ["missing"])).toBeNull();
    expect(skillCommand(`${prefix}plugin:review\nchanges`)?.name).toBe("plugin:review");
    for (const text of [
      `${prefix}review/file`,
      `${prefix}review.md`,
      `${prefix}${prefix}review`,
      "${review}",
      "$(review)",
    ])
      expect(skillCommand(text)).toBeNull();
  });
  test("searches descriptions and prioritizes name prefixes", () => {
    const skills = [
      { id: "a", name: "audit", description: "Review changes" },
      { id: "b", name: "review", description: "Check changes" },
    ];
    expect(matchingSkills(skills, "rev").map((skill) => skill.name)).toEqual(["review", "audit"]);
    expect(matchingSkills(skills, "missing")).toEqual([]);
  });
});

describe("prompt skill selection", () => {
  test.each(["/review,", "/review.", "/review!", "(/review)", "[$review]", "/review;"])(
    "recognizes sentence punctuation in %s",
    (text) => {
      expect(skillCommand(text)?.name).toBe("review");
    },
  );
  test.each([
    "```ts\n/review\n```",
    "~~~\n/review\n~~~",
    "```\n/review",
    "`/review`",
    "`` /review ``",
    "\\/review",
    "\\$review",
    "```\n/review\n```\n`/review`",
  ])("keeps code literal: %s", (text) => {
    expect(skillCommands(text)).toEqual([]);
    expect(skillQuery(text, text.length)).toBeNull();
  });
  test("code fences do not mask invocations after a matching closing fence", () => {
    expect(
      skillCommands("```ts\n/review\n```\nUse $review, then /audit.").map(
        (command) => command.name,
      ),
    ).toEqual(["review", "audit"]);
    expect(
      skillCommands("````\n/review\n```\n/audit\n````\n/review").map((command) => command.name),
    ).toEqual(["review"]);
  });
  test("validates both legacy and multiple selected identities", () => {
    expect(skillSelectionSchema.parse("review")).toBe("review");
    expect(skillSelectionSchema.parse(["review", "audit"])).toEqual(["review", "audit"]);
    for (const invalid of [[], [""], ["x".repeat(129)], Array(2001).fill("review")])
      expect(skillSelectionSchema.safeParse(invalid).success).toBe(false);
  });
  test("handles a near-limit draft mixing many literal and active invocations", () => {
    const text = "`/review` /audit, ".repeat(1700);
    expect(text.length).toBeLessThan(32_000);
    expect(skillCommands(text).map((command) => command.name)).toEqual(Array(1700).fill("audit"));
  });
  for (const prefix of ["/", "$"] as const) {
    test.each([
      `${prefix}review changes`,
      `Please use ${prefix}review on these changes`,
      `Use $HOME then ${prefix}review changes`,
      `👩🏽‍💻 检查\n${prefix}review\r\nSeán O'Brien`,
      `Before\t${prefix}review\tafter`,
    ])("preserves the remembered selection for %s", (text) => {
      expect(promptSkill(text, [review], remembered).skill).toBe(remembered);
    });
    test("keeps surrounding text when normalizing an inline invocation", () => {
      const text = `Please check\n${prefix}review changes\nwith 王秀英`;
      expect(skillInvocationPrompt(text, prefix, "review")).toBe(
        `${prefix}review Please check changes\nwith 王秀英`,
      );
      expect(skillInvocationPrompt(text, prefix, "missing")).toBe(text);
    });
  }
  test("uses remembered identity without a catalog and current identity without a memory", () => {
    expect(promptSkill("Use /review", [], remembered).skill).toBe(remembered);
    expect(promptSkill("Use /review", [review]).skill).toBe(review);
    expect(promptSkill("Use /review", []).skill).toBeUndefined();
  });
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
