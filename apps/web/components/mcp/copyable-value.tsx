"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { SetupValue } from "@/app/mcp/agent-setup";

export function CopyableValue({ value, copyLabel }: SetupValue) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  async function copy() {
    setError("");
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
      setError("Could not copy. Copy the text manually.");
    }
  }

  return (
    <div>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-5 gap-y-2 rounded-lg border border-primary-grey/70 bg-surface/40 px-4 py-3">
        <code className="min-w-0 select-text break-all font-mono text-xs leading-5">{value}</code>
        <Button
          type="button"
          variant="text"
          onClick={() => void copy()}
          aria-label={copyLabel}
          className="shrink-0 rounded px-1 py-1 text-xs font-medium transition-transform duration-150 ease-out hover:text-primary-black active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-orange"
        >
          <span>{copied ? "Copied" : copyLabel}</span>
        </Button>
      </div>
      <span role="status" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
      {error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
