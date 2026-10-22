import { describe, expect, test } from "bun:test";
import { HarnessSkills, type SkillAdapter } from "./harness-skills";
import { matchingSkills, skillCommand, skillQuery } from "../shared/skills";

const provider: SkillAdapter = {
  async discover() {
    return [{ kind: "command", name: "review", description: "Review changes" }];
  },
};

describe("skill catalog boundaries", () => {
  test("deduplicates concurrent discovery and binds ids to project and harness", async () => {
    let discoveries = 0;
    const adapter: SkillAdapter = {
      async discover(input) {
        discoveries++;
        return provider.discover(input);
      },
    };
    const catalog = new HarnessSkills(async () => "/fixture", { codex: adapter, claude: adapter });
    const input = { harness: "claude" as const, cwd: "/project" };
    const [first, second] = await Promise.all([catalog.list(input), catalog.list(input)]);
    expect(discoveries).toBe(1);
    expect(first).toEqual(second);
    const id = first.skills[0].id;
    expect(await catalog.resolve({ ...input, id, prompt: "/review changes" })).toMatchObject({
      name: "review",
    });
    await expect(
      catalog.resolve({ ...input, cwd: "/other", id, prompt: "/review" }),
    ).rejects.toThrow("no longer available");
    await expect(
      catalog.resolve({ ...input, harness: "codex", id, prompt: "/review" }),
    ).rejects.toThrow("no longer available");
    await expect(catalog.resolve({ ...input, id, prompt: "/different" })).rejects.toThrow(
      "no longer available",
    );
    await expect(
      catalog.resolve({ ...input, id: "/etc/passwd", prompt: "/review" }),
    ).rejects.toThrow("no longer available");
  });

  test("refresh removes disabled or deleted skills and failed discovery can retry", async () => {
    let mode: "ready" | "failed" | "empty" = "failed";
    const adapter: SkillAdapter = {
      async discover(input) {
        if (mode === "failed") throw new Error("offline");
        return mode === "empty" ? [] : provider.discover(input);
      },
    };
    const catalog = new HarnessSkills(async () => "/fixture", { codex: adapter, claude: adapter });
    const input = { harness: "claude" as const, cwd: "/project" };
    await expect(catalog.list(input)).rejects.toThrow("offline");
    mode = "ready";
    const result = await catalog.list(input);
    mode = "empty";
    expect((await catalog.list({ ...input, refresh: true })).skills).toEqual([]);
    await expect(
      catalog.resolve({ ...input, id: result.skills[0].id, prompt: "/review" }),
    ).rejects.toThrow("no longer available");
  });
});

describe("slash composer", () => {
  test("only offers skills for an opening slash token", () => {
    expect(skillQuery("/", 1)).toBe("");
    expect(skillQuery("/rev", 4)).toBe("rev");
    expect(skillQuery("/rev existing text", 4)).toBe("rev");
    for (const text of [
      "/tmp/file",
      "https://site",
      "look /review",
      "/review changes",
      "`/review`",
      "\n/review",
    ])
      expect(skillQuery(text, text.length)).toBeNull();
    expect(skillQuery("/review", 3)).toBeNull();
  });
  test("keeps paths and prose literal and matches exact names", () => {
    expect(skillCommand("/review these changes")).toEqual({ name: "review", end: 7 });
    expect(skillCommand("/plugin:review\nchanges")?.name).toBe("plugin:review");
    for (const text of ["/review/file", "/review.md", "run /review", "//review"])
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
