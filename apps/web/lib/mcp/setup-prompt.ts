export function mcpSetupPrompt(resourceUrl: string, organizationId: string) {
  return (
    `Connect this coding agent to Tidy using ${resourceUrl}.\n\n` +
    "Set up the remote Streamable HTTP MCP server using this agent’s supported configuration. " +
    "Preserve any existing MCP servers. Guide me through browser-based OAuth sign-in, " +
    "then verify the connection by listing my Tidy organizations and confirming that " +
    `organization_id ${JSON.stringify(organizationId)} is available. ` +
    "Use this organization for subsequent work: always pass this exact organization_id " +
    "to tools that accept it, and use files belonging to this organization for file-specific tools. " +
    "Do not choose a default or another organization; ask me if this organization is unavailable. " +
    "If this agent cannot configure MCP itself, give me the exact setup steps for this client."
  );
}
