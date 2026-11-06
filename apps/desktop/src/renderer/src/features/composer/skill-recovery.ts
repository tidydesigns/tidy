import { skillCommands, type Skill } from "../../../../shared/contracts/skills";
import type { Draft } from "./machine-context";

export function clearUnchangedSkills(current: Draft, previous: Draft): Draft {
  return {
    ...current,
    skill: current.skill === previous.skill ? undefined : current.skill,
    recoveredSkills:
      current.recoveredSkills === previous.recoveredSkills ? undefined : current.recoveredSkills,
  };
}

export function recoverSkills({
  text,
  ids,
  skills,
  catalogReady,
}: {
  text: string;
  ids: readonly string[];
  skills: readonly Skill[];
  catalogReady: boolean;
}): { kind: "unavailable" } | { kind: "ready"; skills: Pick<Skill, "id" | "name">[] } {
  if (!catalogReady && (ids.length || skillCommands(text).length)) return { kind: "unavailable" };
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
