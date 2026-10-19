"use client";

import { useEffect, useId, useRef, useState } from "react";
import { agentOptions, setupFor, type Agent } from "@/app/mcp/agent-setup";
import { CopyableValue } from "@/components/mcp/copyable-value";
import { McpPromptButton, type SetupPromptProps } from "@/components/mcp/setup-prompt";
import { Dialog } from "@/components/ui/dialog";
import { useFeatureFlag } from "@/lib/use-feature-flag";

export type EditorAgentSetup = Pick<SetupPromptProps, "resourceUrl" | "organizationId">;

export function EditorAgentConnection({ setup, open }: { setup: EditorAgentSetup; open: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);
  const id = useId();
  const [agent, setAgent] = useState<Agent>("codex");
  const [copied, setCopied] = useState(false);
  const additionalClients = useFeatureFlag("mcp-pi-gemini");
  const options = agentOptions.filter(
    (option) => additionalClients || !["pi", "gemini", "other"].includes(option.value),
  );
  const current = options.some((option) => option.value === agent) ? agent : "codex";
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(setup.resourceUrl).hostname);
  const guide = setupFor(current, local ? "tidy-local" : "tidy", setup.resourceUrl);
  return (
    <>
      <button
        type="button"
        onClick={() => dialog.current?.showModal()}
        className="h-9 w-full rounded-md border border-control-border bg-surface px-3 text-xs font-medium hover:bg-primary-grey/20 focus-visible:outline-2 focus-visible:outline-primary-orange active:scale-[0.98]"
      >
        Connect your agent
      </button>
      <Dialog
        ref={dialog}
        size="wide"
        padded={false}
        aria-labelledby={`${id}-title`}
        className="max-w-[860px] overflow-hidden"
        style={{ maxWidth: 860 }}
      >
        <div className="flex items-center justify-between border-b border-primary-grey/60 px-5 py-4">
          <h2 id={`${id}-title`} className="text-base font-medium">
            Connect your agent
          </h2>
          <button
            type="button"
            aria-label="Close agent setup"
            onClick={() => dialog.current?.close()}
            className="flex h-8 w-8 items-center justify-center rounded-md text-secondary-ink hover:bg-primary-grey/20 focus-visible:outline-2 focus-visible:outline-primary-orange"
          >
            ×
          </button>
        </div>
        <div className="grid min-h-0 md:grid-cols-[184px_minmax(0,1fr)]">
          <div
            role="tablist"
            aria-label="Coding agent"
            className="flex gap-1 overflow-x-auto border-b border-primary-grey/60 p-2 md:flex-col md:border-b-0 md:border-r"
          >
            {options.map((option, index) => (
              <button
                key={option.value}
                type="button"
                role="tab"
                id={`${id}-${option.value}`}
                aria-controls={`${id}-guide`}
                aria-selected={current === option.value}
                tabIndex={current === option.value ? 0 : -1}
                onClick={() => {
                  setAgent(option.value);
                  setCopied(false);
                }}
                onKeyDown={(event) => {
                  const next =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? options.length - 1
                        : ["ArrowRight", "ArrowDown"].includes(event.key)
                          ? (index + 1) % options.length
                          : ["ArrowLeft", "ArrowUp"].includes(event.key)
                            ? (index + options.length - 1) % options.length
                            : -1;
                  if (next < 0) return;
                  event.preventDefault();
                  setAgent(options[next].value);
                  setCopied(false);
                  event.currentTarget.parentElement
                    ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                    [next]?.focus();
                }}
                className={`flex shrink-0 items-center gap-2 rounded-md px-3 py-2.5 text-left text-sm focus-visible:outline-2 focus-visible:outline-primary-orange ${current === option.value ? "bg-primary-grey/30" : "text-secondary-ink hover:bg-primary-grey/15"}`}
              >
                {["codex", "claude", "opencode"].includes(option.value) && (
                  <span
                    aria-hidden="true"
                    className="h-5 w-5 shrink-0 bg-current"
                    style={{ mask: `url(/agents/${option.value}.svg) center / contain no-repeat` }}
                  />
                )}
                {option.label}
              </button>
            ))}
          </div>
          <div
            role="tabpanel"
            id={`${id}-guide`}
            aria-labelledby={`${id}-${current}`}
            tabIndex={0}
            className="max-h-[60dvh] min-w-0 overflow-y-auto overscroll-contain p-5 outline-none"
          >
            <div className="mb-5 space-y-3 border-b border-primary-grey/60 pb-5">
              <p className="text-sm text-secondary-ink">
                Copy the setup prompt into your agent, then follow its sign-in instructions.
              </p>
              <McpPromptButton {...setup} copied={copied} onCopied={setCopied} />
            </div>
            <details>
              <summary className="cursor-pointer text-sm font-medium focus-visible:outline-2 focus-visible:outline-primary-orange">
                Manual setup
              </summary>
              <ol className="mt-5 space-y-6">
                {guide.steps.map((step, index) => (
                  <li key={step.title} className="flex gap-3">
                    <span
                      aria-hidden="true"
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary-grey/30 text-xs"
                    >
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1 space-y-2">
                      <h3 className="text-sm font-medium">{step.title}</h3>
                      <p className="text-xs leading-5 text-secondary-ink">{step.description}</p>
                      {step.values.map((value) => (
                        <CopyableValue key={value.value} {...value} />
                      ))}
                    </div>
                  </li>
                ))}
              </ol>
            </details>
          </div>
        </div>
        <div className="flex justify-end border-t border-primary-grey/60 px-5 py-3">
          <button
            type="button"
            onClick={() => dialog.current?.close()}
            className="rounded-md bg-strong-action px-5 py-2 text-sm text-on-strong-action focus-visible:outline-2 focus-visible:outline-primary-orange active:scale-[0.98]"
          >
            Done
          </button>
        </div>
      </Dialog>
    </>
  );
}
