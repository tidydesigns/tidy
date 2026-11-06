import { z } from "zod";

export const skillMessages = {
  unavailable: "This skill is no longer available. Select it again before sending.",
  notInstalled: "Install and sign in to this harness to load skills.",
  discoveryFailed: "The harness could not load its skills. Check the skill definitions and retry.",
} as const;

export const skillNameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,199}$/);
export const skillIdSchema = z.string().min(1).max(128);
export const skillSelectionSchema = z.union([
  skillIdSchema,
  z.array(skillIdSchema).min(1).max(2000),
]);
export type SkillSelection = z.infer<typeof skillSelectionSchema>;
export const skillSchema = z.object({
  id: skillIdSchema,
  name: skillNameSchema,
  description: z.string().max(10_000),
});
export const skillCatalogSchema = z.object({ skills: z.array(skillSchema).max(2000) });
export type Skill = z.infer<typeof skillSchema>;
export type SkillCatalog = z.infer<typeof skillCatalogSchema>;

function skillLiterals(text: string) {
  const ranges: { start: number; end: number }[] = [];
  const markers = /^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)|(`+)|\\[/$]/gm;
  let fence: { start: number; marker: string } | undefined;
  for (const match of text.matchAll(markers)) {
    const previous = ranges.at(-1);
    if (fence) {
      if (
        match[1]?.startsWith(fence.marker.charAt(0)) &&
        match[1].length >= fence.marker.length &&
        !text.slice(match.index + match[1].length, match.index + match[0].length).trim()
      ) {
        ranges.push({ start: fence.start, end: match.index + match[0].length });
        fence = undefined;
      }
    } else if (previous && match.index < previous.end) {
      continue;
    } else if (match[1]) {
      fence = { start: match.index, marker: match[1] };
    } else if (match[2]) {
      const end = text.indexOf(match[2], match.index + match[2].length);
      ranges.push({ start: match.index, end: end < 0 ? text.length : end + match[2].length });
    } else {
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  if (fence) ranges.push({ start: fence.start, end: text.length });
  return ranges;
}

export function skillCommands(text: string) {
  if (!/[/$]/.test(text)) return [];
  const literals = skillLiterals(text);
  let literal = 0;
  return Array.from(
    text.matchAll(
      /(?:^|\s|[([])[/$]([a-zA-Z0-9][a-zA-Z0-9:_-]{0,199})(?=\s|$|[,!?;)\]}…]|\.(?=\s|$))/g,
    ),
    (match) => ({
      name: match[1],
      start: match.index + match[0].length - match[1].length - 1,
      end: match.index + match[0].length,
    }),
  ).filter((command) => {
    let range = literals[literal];
    while (range && range.end <= command.start) {
      range = literals[++literal];
    }
    return !range || command.start < range.start;
  });
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
  if (!match) return null;
  const start = cursor - match[1].length - 1;
  return skillLiterals(text).some((range) => start >= range.start && start < range.end)
    ? null
    : match[1].toLowerCase();
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

export function promptSkill(
  text: string,
  skills: readonly Skill[],
  remembered?: Pick<Skill, "id" | "name">,
) {
  const command =
    skillCommand(
      text,
      skills.map((skill) => skill.name),
    ) ??
    (remembered ? skillCommand(text, [remembered.name]) : null) ??
    skillCommand(text);
  const skill =
    (remembered?.name === command?.name ? remembered : undefined) ??
    skills.find((skill) => skill.name === command?.name);
  return { command, skill };
}
