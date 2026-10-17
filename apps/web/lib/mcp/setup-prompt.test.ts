import { expect, test } from "bun:test";
import { mcpSetupPrompt } from "./setup-prompt";

test("setup prompts preserve the deployment URL and exact selected organization", () => {
  for (const url of ["https://tidy.example/api/mcp", "http://127.0.0.1:3107/api/mcp"]) {
    const organizationId = 'selected-organization-"quoted"';
    const prompt = mcpSetupPrompt(url, organizationId);
    expect(prompt).toContain(url);
    expect(prompt).toContain(`organization_id ${JSON.stringify(organizationId)}`);
    expect(prompt).toContain("Preserve any existing MCP servers");
    expect(prompt).toContain("browser-based OAuth sign-in");
    expect(prompt).toContain("Do not choose a default or another organization");
  }
});
