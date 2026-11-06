import { acpInitializeParams, acpCommandsSchema } from "./opencode-adapter";
import { isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { version } from "../../../package.json";
import type { HarnessId } from "../../shared/contracts/desktop";
import {
  skillCommands,
  skillMessages,
  skillNameSchema,
  type Skill,
  type SkillCatalog,
  type SkillSelection,
} from "../../shared/contracts/skills";
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
const commandSchema = nativeSkillSchema.options[1].omit({ kind: true });
type NativeSkill = z.infer<typeof nativeSkillSchema>;
type CatalogEntry = { public: Skill; native: NativeSkill; legacyId: string };
type CachedCatalog = {
  until: number;
  value: Promise<CatalogEntry[]>;
  ready?: CatalogEntry[];
  pending: boolean;
};
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
          throw new Error(skillMessages.discoveryFailed);
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
  opencode: {
    async discover(input) {
      const commands: NativeSkill[] = [];
      const announced = Promise.withResolvers<void>();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await withHarnessConnection(
          input,
          async (request) => {
            await request("initialize", acpInitializeParams);
            await request("session/new", { cwd: input.cwd, mcpServers: [] });
            await Promise.race([
              announced.promise,
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, 1000);
              }),
            ]);
          },
          (message) => {
            if (message.method !== "session/update") return;
            const parsed = acpCommandsSchema.safeParse(message.params);
            if (parsed.success) {
              commands.length = 0;
              for (const command of parsed.data.update.availableCommands) {
                const entry = commandSchema.safeParse(command);
                if (entry.success) commands.push({ ...entry.data, kind: "command" });
              }
              announced.resolve();
            }
          },
        );
        return commands;
      } finally {
        clearTimeout(timer);
      }
    },
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
  private cache = new Map<string, CachedCatalog>();

  constructor(
    private locate = findHarness,
    private providers: Record<HarnessId, SkillAdapter> = adapters,
    private now = Date.now,
  ) {}

  private entries(
    harness: HarnessId,
    cwd: string,
    refresh = false,
    allowStale = false,
  ): Promise<CatalogEntry[]> {
    const key = JSON.stringify([harness, cwd]);
    const cached = this.cache.get(key);
    if (allowStale && cached?.ready) {
      if (cached.until <= this.now() && !cached.pending)
        void this.entries(harness, cwd, true).catch(() => {});
      return Promise.resolve(cached.ready);
    }
    if (cached && (cached.pending || (!refresh && cached.until > this.now()))) return cached.value;
    const value = (async () => {
      const executable = await this.locate(harness);
      if (!executable) throw new Error(skillMessages.notInstalled);
      const skills = await this.providers[harness].discover({ executable, harness, cwd });
      const names = new Set<string>();
      return skills.slice(0, 2000).flatMap((native): CatalogEntry[] => {
        if (names.has(native.name)) return [];
        names.add(native.name);
        const id = createHash("sha256")
          .update(
            JSON.stringify([
              harness,
              cwd,
              native.kind,
              native.name,
              native.kind === "file" ? native.path : null,
            ]),
          )
          .digest("hex");
        return [
          {
            native,
            legacyId: createHash("sha256")
              .update(JSON.stringify([harness, cwd, native]))
              .digest("hex"),
            public: { id, name: native.name, description: native.description.slice(0, 10_000) },
          },
        ];
      });
    })();
    const entry: CachedCatalog = {
      until: this.now() + 60_000,
      value,
      ready: cached?.ready,
      pending: true,
    };
    if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value ?? "");
    this.cache.set(key, entry);
    void value.then(
      (ready) => {
        entry.ready = ready;
        entry.pending = false;
        entry.until = this.now() + 60_000;
      },
      () => {
        entry.pending = false;
        entry.until = 0;
        if (!entry.ready && this.cache.get(key) === entry) this.cache.delete(key);
      },
    );
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
    const [selected] = await this.resolveSelection(input);
    if (!selected) throw new Error(skillMessages.unavailable);
    return selected.invocation;
  }

  async resolveSelection(input: {
    harness: HarnessId;
    cwd: string;
    id: SkillSelection;
    prompt: string;
    unavailable?: "omit";
  }) {
    const entries = await this.entries(input.harness, input.cwd, false, true);
    const catalog = new Map(
      entries.flatMap((entry) => [
        [entry.public.id, entry.native],
        [entry.legacyId, entry.native],
      ]),
    );
    const names = new Set(skillCommands(input.prompt).map((command) => command.name));
    const seen = new Set<NativeSkill>();
    return [...new Set(Array.isArray(input.id) ? input.id : [input.id])].flatMap((id) => {
      const invocation = catalog.get(id);
      if (!invocation || !names.has(invocation.name)) {
        if (input.unavailable === "omit") return [];
        throw new Error(skillMessages.unavailable);
      }
      if (seen.has(invocation)) return [];
      seen.add(invocation);
      return [{ id, invocation }];
    });
  }
}

export type SkillInvocation = NativeSkill;
