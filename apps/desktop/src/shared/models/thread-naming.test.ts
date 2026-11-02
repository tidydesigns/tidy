import { expect, test } from "bun:test";
import { promptThreadTitle, threadPromptText } from "./thread-naming";
import { threadNamingSchema, threadTitleSchema } from "../contracts/thread-naming";

const image = "[[attachment:b56ba7bb-00aa-4a56-a64c-593c3c377dcc]]";
test("titles describe the written request even when an image comes first", () => {
  expect(promptThreadTitle(`${image}\n\nImprove the\t sidebar spacing`)).toBe(
    "Improve the sidebar spacing",
  );
  expect(promptThreadTitle(`${image} Compare this ${image} with the original`)).toBe(
    "Compare this with the original",
  );
  expect(promptThreadTitle(image)).toBe("New thread");
  expect(promptThreadTitle("a".repeat(100))).toHaveLength(80);
  expect(threadPromptText(`${image}\nDesign a landing page`)).toBe("Design a landing page");
});
test("preferences retain spaces while typing and titles reject empty or multiline output", () => {
  expect(threadNamingSchema.parse({ instructions: "Short task " }).instructions).toBe(
    "Short task ",
  );
  expect(threadNamingSchema.safeParse({ provider: "unknown" }).success).toBe(false);
  expect(threadTitleSchema.safeParse(" ").success).toBe(false);
  expect(threadTitleSchema.safeParse("Title\nExplanation").success).toBe(false);
  expect(threadTitleSchema.safeParse("a".repeat(121)).success).toBe(false);
});

test("title truncation preserves complete emoji and combining sequences within the length limit", () => {
  for (const segment of ["👩🏽‍💻", "👨‍👩‍👧‍👦", "🇮🇪", "e\u0301"]) {
    const prefix = "x".repeat(79);
    expect(promptThreadTitle(prefix + segment + " workspace details")).toBe(prefix.trimEnd());
    const boundary = "x".repeat(80 - segment.length) + segment;
    expect(promptThreadTitle(boundary + " extra details")).toBe(boundary);
    expect(promptThreadTitle(boundary + " extra details").length).toBeLessThanOrEqual(80);
  }
  const prompt = "Please review the workspace navigation and preserve prompt drafts for Priya: 👩🏽‍💻";
  expect(promptThreadTitle(prompt)).toBe(
    "Please review the workspace navigation and preserve prompt drafts for Priya:",
  );
});
