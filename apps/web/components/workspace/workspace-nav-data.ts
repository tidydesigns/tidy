export const workspaceDestinations = [
  { id: "files", href: "/files", label: "Files", icon: "navFolder" },
  { id: "threads", href: "/threads", label: "Threads", icon: "comment" },
  { id: "archive", href: "/files?view=archive", label: "Archive", icon: "archive" },
  { id: "vault", href: "/vault", label: "Vault", icon: "vault" },
  { id: "mcp", href: "/mcp", label: "MCP", icon: "plug" },
  { id: "settings", href: "/settings", label: "Settings", icon: "settings" },
] as const;
