"use client";

import { SelectMenu } from "@/components/ui/select-menu";

export function McpAnalyticsChoice({
  enabled,
  pending,
  onChange,
}: {
  enabled: boolean;
  pending: boolean;
  onChange: (enabled: boolean) => void;
}) {
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
          onChange={(value) => onChange(value === "on")}
        />
      </div>
      <p className="text-sm text-secondary-ink">
        Link MCP usage, performance and errors to your account for 90 days to help troubleshoot
        problems. No prompts or tool content are sent.
      </p>
    </div>
  );
}
