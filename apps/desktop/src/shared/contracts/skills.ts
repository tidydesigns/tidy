import { z } from "zod";

export const skillNameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,199}$/);
export const skillIdSchema = z.string().min(1).max(128);
export const skillSchema = z.object({
  id: skillIdSchema,
  name: skillNameSchema,
  description: z.string().max(10_000),
});
export const skillCatalogSchema = z.object({ skills: z.array(skillSchema).max(2000) });
export type Skill = z.infer<typeof skillSchema>;
export type SkillCatalog = z.infer<typeof skillCatalogSchema>;

export function skillCommands(text: string) {
  return Array.from(
    text.matchAll(/(?:^|\s)[/$]([a-zA-Z0-9][a-zA-Z0-9:_-]{0,199})(?=\s|$)/g),
    (match) => ({
      name: match[1],
      start: match.index + match[0].length - match[1].length - 1,
      end: match.index + match[0].length,
    }),
  );
}

export function skillCommand(text: string, names?: readonly string[]) {
  const allowed = names ? new Set(names) : null;
  return skillCommands(text).find((command) => !allowed || allowed.has(command.name)) ?? null;
}

export function skillInvocationPrompt(text: string, prefix: "/" | "$", name: string) {
  const command = skillCommand(text, [name]);
  if (!command) return text;
  const before = text.slice(0, command.start).trimEnd();
  return `${prefix}${command.name}${before ? ` ${before}` : ""}${text.slice(command.end)}`;
}

export function skillQuery(text: string, cursor: number) {
  if (cursor !== text.length && !/\s/.test(text[cursor] ?? "")) return null;
  const before = text.slice(0, cursor);
  const match = /(?:^|\s)[/$]([a-zA-Z0-9:_-]*)$/.exec(before);
  return match ? match[1].toLowerCase() : null;
}

export function matchingSkills(skills: Skill[], query: string) {
  return skills
    .filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(query))
    .sort(
      (a, b) =>
        Number(b.name.toLowerCase().startsWith(query)) -
          Number(a.name.toLowerCase().startsWith(query)) || a.name.localeCompare(b.name),
    );
}
