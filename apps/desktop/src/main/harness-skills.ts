import { isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { version } from "../../package.json";
import type { HarnessId } from "../shared/contracts";
import { skillCommand, skillNameSchema, type Skill, type SkillCatalog } from "../shared/skills";
import { findHarness } from "./harnesses";
import { withHarnessConnection } from "./harness-connection";

const nativeSkillSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("file"),
    name: skillNameSchema,
    description: z.string(),
    path: z.string().min(1).refine(isAbsolute),
  }),
  z.object({ kind: z.literal("command"), name: skillNameSchema, description: z.string() }),
]);
type NativeSkill = z.infer<typeof nativeSkillSchema>;
type CatalogEntry = { public: Skill; native: NativeSkill };
type DiscoveryInput = { executable: string; harness: HarnessId; cwd: string };
export type SkillAdapter = {
  discover(input: DiscoveryInput): Promise<NativeSkill[]>;
};

const adapters = {
  codex: {
    discover: (input) =>
      withHarnessConnection(input, async (request) => {
        await request("initialize", {
          clientInfo: { name: "tidy_desktop", title: "Tidy", version },
        });
        const result = z
          .object({
            data: z.array(
              z.object({
                cwd: z.string(),
                skills: z.array(
                  z.object({
                    name: z.string(),
                    description: z.string(),
                    path: z.string(),
                    enabled: z.boolean(),
                  }),
                ),
                errors: z.array(z.unknown()).optional(),
              }),
            ),
          })
          .parse(await request("skills/list", { cwds: [input.cwd], forceReload: true }));
        if (result.data.some((entry) => entry.errors?.length && !entry.skills.length))
          throw new Error(
            "The harness could not load its skills. Check the skill definitions and retry.",
          );
        return result.data
          .filter((entry) => entry.cwd === input.cwd)
          .flatMap((entry) =>
            entry.skills
              .filter((skill) => skill.enabled)
              .flatMap((skill) => {
                const parsed = nativeSkillSchema.safeParse({ ...skill, kind: "file" });
                return parsed.success ? [parsed.data] : [];
              }),
          );
      }),
  },
  claude: {
    discover: (input) =>
      withHarnessConnection(input, async (request) => {
        const result = z
          .object({ commands: z.array(z.object({ name: z.string(), description: z.string() })) })
          .parse(await request("initialize"));
        return result.commands.flatMap((command) => {
          const parsed = nativeSkillSchema.safeParse({ ...command, kind: "command" });
          return parsed.success ? [parsed.data] : [];
        });
      }),
  },
} satisfies Record<HarnessId, SkillAdapter>;

export class HarnessSkills {
  private cache = new Map<string, { until: number; value: Promise<CatalogEntry[]> }>();

  constructor(
    private locate = findHarness,
    private providers: Record<HarnessId, SkillAdapter> = adapters,
  ) {}

  private entries(harness: HarnessId, cwd: string, refresh = false) {
    const key = JSON.stringify([harness, cwd]);
    const cached = this.cache.get(key);
    if (!refresh && cached && cached.until > Date.now()) return cached.value;
    const value = (async () => {
      const executable = await this.locate(harness);
      if (!executable) throw new Error("Install and sign in to this harness to load skills.");
      const skills = await this.providers[harness].discover({ executable, harness, cwd });
      const names = new Set<string>();
      return skills.slice(0, 2000).flatMap((native): CatalogEntry[] => {
        if (names.has(native.name)) return [];
        names.add(native.name);
        const id = createHash("sha256")
          .update(JSON.stringify([harness, cwd, native]))
          .digest("hex");
        return [
          {
            native,
            public: { id, name: native.name, description: native.description.slice(0, 10_000) },
          },
        ];
      });
    })();
    const entry = { until: Date.now() + 60_000, value };
    if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value ?? "");
    this.cache.set(key, entry);
    void value.catch(() => {
      if (this.cache.get(key) === entry) this.cache.delete(key);
    });
    return value;
  }

  async list(input: { harness: HarnessId; cwd: string; refresh?: boolean }): Promise<SkillCatalog> {
    return {
      skills: (await this.entries(input.harness, input.cwd, input.refresh)).map(
        (entry) => entry.public,
      ),
    };
  }

  async resolve(input: {
    harness: HarnessId;
    cwd: string;
    id: string;
    prompt: string;
  }): Promise<NativeSkill> {
    const entries = await this.entries(input.harness, input.cwd);
    const entry = entries.find((entry) => entry.public.id === input.id);
    if (!entry || skillCommand(input.prompt)?.name !== entry.native.name)
      throw new Error("This skill is no longer available. Select it again before sending.");
    return entry.native;
  }
}

export type SkillInvocation = NativeSkill;
