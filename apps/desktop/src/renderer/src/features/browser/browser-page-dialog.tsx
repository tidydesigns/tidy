import { useEffect, useRef, useState, type RefObject } from "react";
import { Button } from "@tidy/ui/button";
import type { BrowserState, BrowserInput } from "../../../../shared/contracts/browser";
export function BrowserPageDialog({
  dialog,
  enabled,
  send,
  keyboard,
  error,
}: {
  dialog: NonNullable<BrowserState["dialog"]>;
  enabled: boolean;
  send(input: BrowserInput): void;
  keyboard: RefObject<HTMLTextAreaElement | null>;
  error: string;
}) {
  const promptInput = useRef<HTMLInputElement>(null);
  const dialogElement = useRef<HTMLDivElement>(null);
  const [responding, setResponding] = useState(false);
  useEffect(() => setResponding(false), [error, enabled]);
  const respondToDialog = (accept: boolean) => {
    if (!enabled || responding) return;
    setResponding(true);
    send({ kind: "dialog", dialogId: dialog.id, accept, text: promptInput.current?.value ?? "" });
    keyboard.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (!enabled || responding) return;
    const target =
      promptInput.current ??
      dialogElement.current?.querySelector<HTMLButtonElement>("[data-dialog-accept]");
    target?.focus();
    promptInput.current?.select();
  }, [enabled, responding]);
  if (responding) return null;
  return (
    <div className="browser-dialog-backdrop absolute inset-0 z-2 grid place-items-center bg-black/15 p-5">
      <div
        ref={dialogElement}
        className="browser-dialog w-full max-w-80 rounded-lg border border-border bg-panel p-4 shadow-[0_8px_24px_#0000001a]"
        role="dialog"
        aria-modal="true"
        aria-label="Page dialog"
        onKeyDown={(event) => {
          if (!enabled || event.nativeEvent.isComposing) return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            respondToDialog(false);
          } else if (event.key === "Tab" && !event.ctrlKey && !event.metaKey) {
            const controls = Array.from(
              event.currentTarget.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
                "input:not(:disabled),button:not(:disabled)",
              ),
            );
            const first = controls[0],
              last = controls.at(-1);
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <p className="mt-0 mb-4 max-h-40 overflow-auto leading-[1.6] wrap-anywhere">
          {dialog.message}
        </p>
        {dialog.type === "prompt" && (
          <input
            key={dialog.id}
            ref={promptInput}
            className="w-full rounded border border-border bg-surface p-1.5 text-ink"
            aria-label="Page prompt"
            defaultValue={dialog.defaultValue}
            disabled={!enabled}
            onKeyDown={(event) => {
              if (event.key === "Enter" && enabled && !event.nativeEvent.isComposing) {
                event.preventDefault();
                respondToDialog(true);
              }
            }}
          />
        )}
        <div className="mt-4 flex justify-end gap-2">
          {dialog.type !== "alert" && (
            <Button
              type="button"
              className="cursor-pointer rounded border border-border bg-surface px-3 py-[5px] text-ink"
              disabled={!enabled}
              onClick={() => respondToDialog(false)}
            >
              {dialog.type === "beforeunload" ? "Stay here" : "Cancel"}
            </Button>
          )}
          <Button
            type="button"
            className="cursor-pointer rounded border border-border bg-surface px-3 py-[5px] text-ink"
            data-dialog-accept
            disabled={!enabled}
            onClick={() => respondToDialog(true)}
          >
            {dialog.type === "beforeunload" ? "Leave page" : "OK"}
          </Button>
        </div>
      </div>
    </div>
  );
}
