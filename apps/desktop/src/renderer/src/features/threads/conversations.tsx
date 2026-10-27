import { Activity, lazy, Suspense, useLayoutEffect, useRef, useState } from "react";
import type { DesktopAPI, Thread } from "../../../../shared/contracts/desktop";
import { loadConversation } from "./load-conversation";
import { retainConversations } from "./conversation-cache";

const Conversation = lazy(() =>
  loadConversation().then((module) => ({ default: module.Conversation })),
);

export function Conversations({
  projectId,
  selected,
  threads,
  api,
  active,
}: {
  projectId: string;
  selected: string | null;
  threads: Readonly<Partial<Record<string, Thread>>>;
  api: DesktopAPI;
  active: boolean;
}) {
  const [visited, setVisited] = useState(active);
  if (active && !visited) setVisited(true);
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
  if (!visited && !active) return null;
  return retained.map((id) => (
    <Activity key={id ?? "draft"} mode={active && id === selected ? "visible" : "hidden"}>
      <Suspense fallback={null}>
        <Conversation
          identity={`${projectId}:${id ?? "draft"}`}
          thread={
            id ? (active && id === selected ? threads[id] : rendered.current.get(id)) : undefined
          }
          active={active && id === selected}
          api={api}
        />
      </Suspense>
    </Activity>
  ));
}
