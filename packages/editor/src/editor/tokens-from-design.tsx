"use client";

import { useState } from "react";
import { SelectMenu } from "../components/ui/select-menu";
import { colorTokenRequest } from "../design/token-request";

export type TokenAgentRequest = { prompt: string; selectedIds: string[] };

export function TokensFromDesign({
  fileId,
  pageId,
  selectedIds,
  onAskAgent,
  onClose,
}: {
  fileId: string;
  pageId: string;
  selectedIds: string[];
  onAskAgent?: (request: TokenAgentRequest) => void;
  onClose: () => void;
}) {
  const [scope, setScope] = useState(selectedIds.length ? "selection" : "page");
  const [copiedPrompt, setCopiedPrompt] = useState("");
  const [error, setError] = useState("");
  const ids = scope === "selection" ? selectedIds : [];
  const prompt = colorTokenRequest({ fileId, pageId, selectedIds: ids });
  const disabled = scope === "selection" && !ids.length;
  const control =
    "rounded-md border border-control-border px-2 py-1.5 text-xs focus-visible:outline-2 focus-visible:outline-primary-orange";
  return (
    <section
      aria-label="Colors from design"
      className="mb-4 space-y-3 border-b border-primary-grey/60 pb-3"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">Colors from design</span>
        <button
          type="button"
          aria-label="Close colors from design"
          className={control}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <SelectMenu
        label="Color source"
        value={scope}
        replayLabel
        replayOptions
        options={[
          { value: "page", label: "Current page" },
          {
            value: "selection",
            label: "Selection and children",
            disabled: !selectedIds.length,
          },
        ]}
        onChange={(value) => {
          setScope(value);
          setCopiedPrompt("");
          setError("");
        }}
      />
      <p className="text-xs leading-relaxed text-secondary-ink">
        Ask an agent to find the palette, name colors by their role, and link them to this design.
      </p>
      {onAskAgent ? (
        <button
          type="button"
          disabled={disabled}
          className={`${control} w-full hover:bg-hover-surface disabled:opacity-40`}
          onClick={() => onAskAgent({ prompt, selectedIds: [...ids] })}
        >
          Ask agent…
        </button>
      ) : (
        <>
          <button
            type="button"
            disabled={disabled}
            className={`${control} w-full hover:bg-hover-surface disabled:opacity-40`}
            onClick={async () => {
              setError("");
              try {
                await navigator.clipboard.writeText(prompt);
                setCopiedPrompt(prompt);
              } catch {
                setCopiedPrompt("");
                setError("Could not copy. Select the request below and copy it manually.");
              }
            }}
          >
            {copiedPrompt === prompt ? "Copied request" : "Copy agent request"}
          </button>
          <p className="text-[11px] leading-relaxed text-secondary-ink">
            Paste into your agent connected to Tidy.
          </p>
          <details>
            <summary className="cursor-pointer text-xs text-secondary-ink">View request</summary>
            <textarea
              aria-label="Agent request"
              readOnly
              value={prompt}
              className={`${control} mt-2 h-32 w-full resize-y bg-surface text-secondary-ink`}
            />
          </details>
          {error && (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}
        </>
      )}
    </section>
  );
}
