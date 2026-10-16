"use client";

import { useState } from "react";
import { MCP_NOTICE_VERSION } from "@/lib/privacy/consent";
import { SelectMenu } from "@/components/ui/select-menu";

export function McpAnalyticsChoice({ initialEnabled }: { initialEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function choose(next: boolean) {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/privacy/mcp-analytics", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tidy-privacy": "1" },
        body: JSON.stringify({ enabled: next, noticeVersion: MCP_NOTICE_VERSION }),
      });
      if (!response.ok) throw new Error();
      const result = (await response.json()) as { enabled?: unknown };
      if (typeof result.enabled !== "boolean") throw new Error();
      setEnabled(result.enabled);
    } catch {
      setError("Your choice could not be confirmed. Please try again; it may not have changed.");
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="ph-no-capture space-y-2">
      <div className="flex items-center justify-between gap-4">
        <span className="text-sm font-medium">Link MCP monitoring to my account</span>
        <SelectMenu
          label="Link MCP monitoring to my account"
          value={enabled ? "on" : "off"}
          disabled={pending}
          options={[
            { value: "off", label: "Off" },
            { value: "on", label: "On" },
          ]}
          onChange={(value) => void choose(value === "on")}
        />
      </div>
      <p className="text-sm text-secondary-ink">
        Tidy monitors tool counts, timings and failures to operate the MCP service. Turn this on to
        let us associate those events with your account for troubleshooting for 90 days. Off stops
        account linking; service monitoring continues. No prompts or tool content are sent. This is
        separate from browser choices and does not affect MCP access.
      </p>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
