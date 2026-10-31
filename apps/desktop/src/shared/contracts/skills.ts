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

export function skillCommand(text: string) {
  const match = /^[/$]([a-zA-Z0-9][a-zA-Z0-9:_-]{0,199})(?=\s|$)/.exec(text);
  return match ? { name: match[1], end: match[0].length } : null;
}

export function skillQuery(text: string, cursor: number) {
  if (cursor !== text.length && !/\s/.test(text[cursor] ?? "")) return null;
  const before = text.slice(0, cursor);
  return /^[/$][a-zA-Z0-9:_-]*$/.test(before) ? before.slice(1).toLowerCase() : null;
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
