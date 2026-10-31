import { describe, expect, test } from "bun:test";
import { HarnessSkills, type SkillAdapter } from "./harness-skills";
import { matchingSkills, skillCommand, skillQuery } from "../../shared/contracts/skills";

const provider: SkillAdapter = {
  async discover() {
    return [{ kind: "command", name: "review", description: "Review changes" }];
  },
};

describe("skill catalog boundaries", () => {
  for (const harness of ["codex", "claude", "opencode"] as const) {
    test.each(["/", "$"])(
      `${harness} resolves %s selections with the same catalog id`,
      async (prefix) => {
        const catalog = new HarnessSkills(async () => "/fixture", {
          codex: provider,
          claude: provider,
          opencode: provider,
        });
        const input = { harness, cwd: "/project" };
        const { skills } = await catalog.list(input);
        expect(
          await catalog.resolve({ ...input, id: skills[0].id, prompt: `${prefix}review changes` }),
        ).toMatchObject({ name: "review" });
        await expect(
          catalog.resolve({ ...input, id: skills[0].id, prompt: `${prefix}other` }),
        ).rejects.toThrow("no longer available");
      },
    );
  }

  test("deduplicates concurrent discovery and binds ids to project and harness", async () => {
    let discoveries = 0;
    const adapter: SkillAdapter = {
      async discover(input) {
        discoveries++;
        return provider.discover(input);
      },
    };
    const catalog = new HarnessSkills(async () => "/fixture", {
      codex: adapter,
      claude: adapter,
      opencode: adapter,
    });
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

  test("expired selections resolve while one background refresh is pending, then honor removals", async () => {
    let now = 0;
    let calls = 0;
    const refresh = Promise.withResolvers<Awaited<ReturnType<SkillAdapter["discover"]>>>();
    const adapter: SkillAdapter = {
      discover(input) {
        return ++calls === 1 ? provider.discover(input) : refresh.promise;
      },
    };
    const catalog = new HarnessSkills(
      async () => "/fixture",
      { codex: adapter, claude: adapter, opencode: adapter },
      () => now,
    );
    const input = { harness: "claude" as const, cwd: "/project" };
    const { skills } = await catalog.list(input);
    now = 60_001;
    const selection = { ...input, id: skills[0].id, prompt: "/review changes" };
    expect((await catalog.resolve(selection)).name).toBe("review");
    expect((await catalog.resolve(selection)).name).toBe("review");
    expect(calls).toBe(2);
    let listed = false;
    const listing = catalog.list(input).then((value) => {
      listed = true;
      return value;
    });
    await Promise.resolve();
    expect(listed).toBe(false);
    refresh.resolve([]);
    expect((await listing).skills).toEqual([]);
    await expect(catalog.resolve(selection)).rejects.toThrow("no longer available");
  });

  test("failed background refresh preserves the last successful selection and can retry", async () => {
    let now = 0;
    const refresh = Promise.withResolvers<Awaited<ReturnType<SkillAdapter["discover"]>>>();
    let calls = 0;
    const adapter: SkillAdapter = {
      discover(input) {
        return ++calls === 2 ? refresh.promise : provider.discover(input);
      },
    };
    const catalog = new HarnessSkills(
      async () => "/fixture",
      { codex: adapter, claude: adapter, opencode: adapter },
      () => now,
    );
    const input = { harness: "claude" as const, cwd: "/project" };
    const { skills } = await catalog.list(input);
    const selection = { ...input, id: skills[0].id, prompt: "/review" };
    now = 60_001;
    expect((await catalog.resolve(selection)).name).toBe("review");
    const listing = catalog.list(input);
    refresh.reject(new Error("offline"));
    await expect(listing).rejects.toThrow("offline");
    expect((await catalog.resolve(selection)).name).toBe("review");
    expect((await catalog.list(input)).skills).toEqual(skills);
    expect(calls).toBe(3);
  });

  test("refresh removes disabled or deleted skills and failed discovery can retry", async () => {
    let mode: "ready" | "failed" | "empty" = "failed";
    const adapter: SkillAdapter = {
      async discover(input) {
        if (mode === "failed") throw new Error("offline");
        return mode === "empty" ? [] : provider.discover(input);
      },
    };
    const catalog = new HarnessSkills(async () => "/fixture", {
      codex: adapter,
      claude: adapter,
      opencode: adapter,
    });
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

describe("skill composer", () => {
  test.each(["/", "$"])("only offers skills for an opening %s token", (prefix) => {
    expect(skillQuery(prefix, 1)).toBe("");
    expect(skillQuery(`${prefix}rev`, 4)).toBe("rev");
    expect(skillQuery(`${prefix}REV`, 4)).toBe("rev");
    expect(skillQuery(`${prefix}rev existing text`, 4)).toBe("rev");
    for (const text of [
      `${prefix}tmp/file`,
      "https://site",
      `look ${prefix}review`,
      `${prefix}review changes`,
      "`" + prefix + "review`",
      `\n${prefix}review`,
      "${review}",
      "$(review)",
      "$$review",
    ])
      expect(skillQuery(text, text.length)).toBeNull();
    expect(skillQuery(`${prefix}review`, 3)).toBeNull();
  });
  test.each(["/", "$"])(
    "parses opening %s commands and keeps paths and prose literal",
    (prefix) => {
      expect(skillCommand(`${prefix}review these changes`)).toEqual({ name: "review", end: 7 });
      expect(skillCommand(`${prefix}plugin:review\nchanges`)?.name).toBe("plugin:review");
      for (const text of [
        `${prefix}review/file`,
        `${prefix}review.md`,
        `run ${prefix}review`,
        `${prefix}${prefix}review`,
        "${review}",
        "$(review)",
      ])
        expect(skillCommand(text)).toBeNull();
    },
  );
  test("searches descriptions and prioritizes name prefixes", () => {
    const skills = [
      { id: "a", name: "audit", description: "Review changes" },
      { id: "b", name: "review", description: "Check changes" },
    ];
    expect(matchingSkills(skills, "rev").map((skill) => skill.name)).toEqual(["review", "audit"]);
    expect(matchingSkills(skills, "missing")).toEqual([]);
  });
});
