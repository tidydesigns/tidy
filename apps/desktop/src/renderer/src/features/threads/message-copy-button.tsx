import { useEffect, useRef, useState } from "react";
import { Button } from "@tidy/ui/button";
import { Icon } from "@tidy/editor/components/ui/icon";
import { showToast } from "@tidy/ui/toast";
import type { Message } from "../../../../shared/contracts/desktop";
import { copyMessage } from "./message-clipboard";

export function MessageCopyButton({
  message,
  projectId,
  machineId = "local",
}: {
  message: Message;
  projectId: string;
  machineId?: string;
}) {
  return (
    <ClipboardCopyButton
      label="Copy prompt"
      copiedLabel="Prompt copied"
      onCopy={() => copyMessage({ message, projectId, machineId })}
    />
  );
}

export function ClipboardCopyButton({
  label,
  copiedLabel = "Copied",
  onCopy,
  className = "",
}: {
  label: string;
  copiedLabel?: string;
  onCopy(): Promise<void>;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);
  async function copy() {
    if (pending.current) return;
    pending.current = true;
    try {
      await onCopy();
      if (!mounted.current) return;
      clearTimeout(timer.current);
      setCopied(true);
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      if (mounted.current) {
        clearTimeout(timer.current);
        setCopied(false);
        showToast("Could not copy. Please try again.");
      }
    } finally {
      pending.current = false;
    }
  }
  return (
    <Button
      type="button"
      className={`message-copy-button flex size-7 cursor-pointer items-center justify-center rounded-md hover:text-[light-dark(#292929,#ffffff)] focus-visible:outline-2 focus-visible:outline-offset-2 ${className}`}
      data-copied={copied || undefined}
      aria-label={copied ? copiedLabel : label}
      title={copied ? copiedLabel : label}
      onClick={() => void copy()}
    >
      <span className="message-copy-icons" aria-hidden="true">
        <span className="message-copy-original">
          <Icon name="copy" size={16} />
        </span>
        <span className="message-copy-check">
          <Icon name="check" size={16} />
        </span>
      </span>
      <span className="sr-only" role="status">
        {copied ? copiedLabel : ""}
      </span>
    </Button>
  );
}
