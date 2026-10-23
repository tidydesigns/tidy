import type { DesignSummary, Thread } from "./contracts";

/** Resolve activity against known project designs; tool text never becomes a filesystem target. */
export function threadDesigns(thread: Thread, designs: DesignSummary[]) {
  const result: DesignSummary[] = [];
  const add = (design: DesignSummary | undefined) => {
    if (design && !result.some((item) => item.id === design.id)) result.push(design);
  };
  const turn = [...thread.messages].reverse().find((message) => message.role === "user")?.id;
  const tools = (thread.toolActivities ?? []).filter(
    (tool) =>
      tool.afterMessageId === turn && (tool.status === "running" || tool.status === "completed"),
  );
  for (const tool of tools.reverse()) {
    const paths = tool.files?.filter((file) => file.kind !== "deleted").map((file) => file.path);
    // Shell tools and reads expose the path in their input rather than a files list.
    const text = `${tool.title}\n${tool.input ?? ""}\n${paths?.join("\n") ?? ""}`.replace(
      /\\+/g,
      "/",
    );
    const matches = [
      ...text.matchAll(/(?:^|[\s/'"`=:])\.tidy\/designs\/([\da-f-]+)\.json(?![\w.-])/gi),
    ];
    for (const match of matches.reverse()) {
      if (tool.files?.some((file) => file.kind === "deleted" && file.path.includes(match[1])))
        continue;
      const design = designs.find((design) => design.id === match[1]);
      add(design);
    }
  }
  thread.designIds.forEach((id) => add(designs.find((design) => design.id === id)));
  return result;
}

export function threadDesign(thread: Thread, designs: DesignSummary[]) {
  return threadDesigns(thread, designs)[0];
}
