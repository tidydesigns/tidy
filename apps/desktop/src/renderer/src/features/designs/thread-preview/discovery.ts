import type { DesignSummary, Thread } from "../../../../../shared/contracts/desktop";
import type { ToolActivity } from "../../../../../shared/contracts/tool-activity";

/** Resolve activity against known project designs; tool text never becomes a filesystem target. */
export function threadDesigns(
  thread: Pick<Thread, "messages" | "toolActivities" | "designIds">,
  designs: DesignSummary[],
  pathCache?: WeakMap<ToolActivity, string[]>,
) {
  const result: DesignSummary[] = [];
  const known = new Map(designs.map((design) => [design.id, design]));
  const seen = new Set<string>();
  const add = (design: DesignSummary | undefined) => {
    if (design && !seen.has(design.id)) {
      seen.add(design.id);
      result.push(design);
    }
  };
  const turn = [...thread.messages].reverse().find((message) => message.role === "user")?.id;
  const tools = (thread.toolActivities ?? []).filter(
    (tool) =>
      tool.afterMessageId === turn && (tool.status === "running" || tool.status === "completed"),
  );
  for (const tool of tools.reverse()) {
    let targets = pathCache?.get(tool);
    if (!targets) {
      const paths = tool.files?.filter((file) => file.kind !== "deleted").map((file) => file.path);
      const text = `${tool.title}\n${tool.input ?? ""}\n${paths?.join("\n") ?? ""}`.replace(
        /\\+/g,
        "/",
      );
      const matches = [
        ...text.matchAll(/(?:^|[\s/'"`=:])\.tidy\/designs\/([\da-f-]+)\.json(?![\w.-])/gi),
      ];
      targets = matches
        .reverse()
        .filter(
          (match) =>
            !tool.files?.some((file) => file.kind === "deleted" && file.path.includes(match[1])),
        )
        .map((match) => match[1]);
      pathCache?.set(tool, targets);
    }
    targets.forEach((id) => add(known.get(id)));
  }
  thread.designIds.forEach((id) => add(known.get(id)));
  return result;
}

export function threadDesign(thread: Thread, designs: DesignSummary[]) {
  return threadDesigns(thread, designs)[0];
}
