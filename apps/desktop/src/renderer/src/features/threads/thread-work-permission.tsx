import { useEffect, useRef, useState } from "react";
import { SelectMenu } from "@tidy/ui/select-menu";
import { showToast } from "@tidy/ui/toast";
import type { DesktopAPI, ThreadSummary } from "../../../../shared/contracts/desktop";

export function ThreadWorkPermission({ api, thread }: { api: DesktopAPI; thread: ThreadSummary }) {
  const [enabled, setEnabled] = useState(Boolean(thread.acceptsThreadWork));
  const server = useRef(enabled);
  const sequence = useRef(0);
  const pending = useRef(0);
  const writes = useRef(Promise.resolve());
  useEffect(() => {
    server.current = Boolean(thread.acceptsThreadWork);
    if (!pending.current) setEnabled(server.current);
  }, [thread.acceptsThreadWork]);
  if (!api.setThreadWorkPermission || thread.parentThreadId) return null;
  return (
    <SelectMenu
      label="Incoming thread work"
      value={enabled ? "allowed" : "blocked"}
      triggerContent={enabled ? "Incoming work allowed" : "Incoming work blocked"}
      triggerClassName="quiet-button text-xs shrink-0"
      placement="bottom"
      options={[
        { value: "blocked", label: "Block work from other threads" },
        { value: "allowed", label: "Allow work from other threads" },
      ]}
      onChange={(value) => {
        const next = value === "allowed";
        const request = ++sequence.current;
        pending.current++;
        setEnabled(next);
        writes.current = writes.current.then(async () => {
          try {
            await api.setThreadWorkPermission!(thread.projectId, thread.id, next);
            server.current = next;
          } catch {
            if (request === sequence.current) setEnabled(server.current);
            showToast("Could not update incoming work permission. Try again.", "error");
          } finally {
            pending.current--;
          }
        });
      }}
    />
  );
}
