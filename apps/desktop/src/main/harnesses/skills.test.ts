import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { HarnessSkills, type SkillAdapter } from "./harness-skills";
import { promptSkill } from "../../shared/contracts/skills";

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
          await catalog.resolve({
            ...input,
            id: skills[0].id,
            prompt: `Use $HOME then ${prefix}review changes`,
          }),
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

describe("skill identity across catalog updates", () => {
  for (const cwd of ["/home/alex/Design projects/应用", "/Users/alex/Design projects/应用"]) {
    test.each(["codex", "claude", "opencode"] as const)(
      `%s keeps selections across description changes in ${cwd}`,
      async (harness) => {
        let description = "Review changes";
        let path = `${cwd}/.agents/skills/review/SKILL.md`;
        const adapter: SkillAdapter = {
          async discover() {
            return [{ kind: "file", name: "review", description, path }];
          },
        };
        const catalog = new HarnessSkills(async () => "/fixture", {
          codex: adapter,
          claude: adapter,
          opencode: adapter,
        });
        const input = { harness, cwd };
        const first = await catalog.list(input);
        description = "Review architecture, security and performance — 检查";
        const refreshed = await catalog.list({ ...input, refresh: true });
        expect(refreshed.skills[0].description).toBe(description);
        expect(refreshed.skills[0].id).toBe(first.skills[0].id);
        const selection = { ...input, id: first.skills[0].id, prompt: "Please use $review here" };
        expect(await catalog.resolve(selection)).toMatchObject({ description, path });
        path = `${cwd}/.agents/skills/moved-review/SKILL.md`;
        await catalog.list({ ...input, refresh: true });
        await expect(catalog.resolve(selection)).rejects.toThrow("no longer available");
      },
    );
  }
});

test("persisted selections from earlier versions remain bound to the exact native skill", async () => {
  const input = { harness: "claude" as const, cwd: "/project" };
  const native = { kind: "command" as const, name: "review", description: "Review changes" };
  const id = createHash("sha256")
    .update(JSON.stringify([input.harness, input.cwd, native]))
    .digest("hex");
  const catalog = new HarnessSkills(async () => "/fixture", {
    codex: provider,
    claude: provider,
    opencode: provider,
  });
  expect(await catalog.resolve({ ...input, id, prompt: "Please use $review here" })).toEqual(
    native,
  );
  await expect(catalog.resolve({ ...input, id, prompt: "Please use $other here" })).rejects.toThrow(
    "no longer available",
  );
  await expect(catalog.resolve({ ...input, cwd: "/other", id, prompt: "$review" })).rejects.toThrow(
    "no longer available",
  );
  await expect(
    catalog.resolve({ ...input, harness: "codex", id, prompt: "$review" }),
  ).rejects.toThrow("no longer available");
});

for (const harness of ["codex", "claude", "opencode"] as const) {
  test.each(["/", "$"])(
    `${harness} requires reselection when a same-name file skill moves (%s)`,
    async (prefix) => {
      const cwd = "/project";
      let path = "/project/.agents/skills/review/SKILL.md";
      const adapter: SkillAdapter = {
        async discover() {
          return [{ kind: "file", name: "review", description: "Review changes", path }];
        },
      };
      const catalog = new HarnessSkills(async () => "/fixture", {
        codex: adapter,
        claude: adapter,
        opencode: adapter,
      });
      const input = { harness, cwd };
      const initial = await catalog.list(input);
      const remembered = initial.skills[0];
      path = "/project/.agents/skills/replacement/SKILL.md";
      const refreshed = await catalog.list({ ...input, refresh: true });
      const prompt = `Please use ${prefix}review on these changes`;
      const selection = promptSkill(prompt, refreshed.skills, remembered);
      expect(selection.skill?.id).toBe(remembered.id);
      await expect(
        catalog.resolve({ ...input, prompt, id: selection.skill?.id ?? "" }),
      ).rejects.toThrow("no longer available");
      const reselected = promptSkill(prompt, refreshed.skills);
      expect(reselected.skill?.id).not.toBe(remembered.id);
      expect(
        await catalog.resolve({ ...input, prompt, id: reselected.skill?.id ?? "" }),
      ).toMatchObject({ path });
    },
  );
}
