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
        <span className="text-sm font-medium">MCP usage analytics</span>
        <SelectMenu
          label="MCP usage analytics"
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
        Share tool names, timings and outcomes with PostHog to improve Tidy. No prompts or tool
        content. Applies to your account’s connected agents for 90 days, separately from browser
        choices. Turning it off does not affect MCP access.
      </p>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
