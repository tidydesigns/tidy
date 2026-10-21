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
      if (response.status === 409) {
        setError("Reload Tidy to review the current MCP analytics notice.");
        return;
      }
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
        <span className="text-sm font-medium">Account-linked MCP diagnostics</span>
        <SelectMenu
          label="Account-linked MCP diagnostics"
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
        Link MCP tool counts, timings, failures and client application names and versions to your
        account for troubleshooting for 90 days. This applies across your account, independently of
        browser choices. Service monitoring continues when off. No prompts or tool content are sent,
        and MCP access is unaffected.
      </p>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
