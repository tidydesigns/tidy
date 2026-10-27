import { Activity, useLayoutEffect, useRef, useState } from "react";
import type { DesktopAPI, Thread } from "../../../../shared/contracts/desktop";
import { Conversation } from "./conversation";
import { retainConversations } from "./conversation-cache";

export function Conversations({
  projectId,
  selected,
  threads,
  api,
  active,
}: {
  projectId: string;
  selected: string | null;
  threads: Record<string, Thread>;
  api: DesktopAPI;
  active: boolean;
}) {
  const [recent, setRecent] = useState<(string | null)[]>([selected]);
  const rendered = useRef(new Map<string, Thread>());
  const retained = retainConversations({ recent, selected, threads });
  if (recent.length !== retained.length || recent.some((id, index) => id !== retained[index]))
    setRecent(retained);
  useLayoutEffect(() => {
    const thread = selected ? threads[selected] : undefined;
    if (active && thread && selected) rendered.current.set(selected, thread);
    for (const id of rendered.current.keys()) {
      if (!retained.includes(id)) rendered.current.delete(id);
    }
  });
  return retained.map((id) => (
    <Activity key={id ?? "draft"} mode={active && id === selected ? "visible" : "hidden"}>
      <Conversation
        identity={`${projectId}:${id ?? "draft"}`}
        thread={
          id ? (active && id === selected ? threads[id] : rendered.current.get(id)) : undefined
        }
        active={active && id === selected}
        api={api}
      />
    </Activity>
  ));
}
