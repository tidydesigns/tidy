import { skillCommands, type Skill } from "../../../../shared/contracts/skills";

export function recoverSkills({
  text,
  ids,
  skills,
}: {
  text: string;
  ids: readonly string[];
  skills: readonly Skill[];
}): { kind: "unavailable" } | { kind: "ready"; skills: Pick<Skill, "id" | "name">[] } {
  if (!ids.length) return { kind: "ready", skills: [] };
  const catalog = new Map(skills.map((skill) => [skill.id, skill]));
  const names = new Set(skillCommands(text).map((command) => command.name));
  const selected: Pick<Skill, "id" | "name">[] = [];
  for (const id of new Set(ids)) {
    const skill = catalog.get(id);
    if (!skill) return { kind: "unavailable" };
    if (names.has(skill.name)) selected.push({ id, name: skill.name });
  }
  return { kind: "ready", skills: selected };
}
