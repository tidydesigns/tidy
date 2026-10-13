export const agentOptions = [
  { value: "codex", label: "Codex" },
  { value: "claude", label: "Claude Code" },
  { value: "opencode", label: "OpenCode" },
  { value: "pi", label: "Pi" },
  { value: "gemini", label: "Gemini CLI" },
  { value: "other", label: "Other MCP client" },
] as const;

export type Agent = (typeof agentOptions)[number]["value"];
export type SetupValue = { value: string; copyLabel: "Copy command" | "Copy URL" | "Copy prompt" };
export type SetupStep = { title: string; description: string; values: SetupValue[] };

const command = (value: string): SetupValue => ({ value, copyLabel: "Copy command" });
const url = (value: string): SetupValue => ({ value, copyLabel: "Copy URL" });

export function setupFor(agent: Agent, name: string, resourceUrl: string) {
  const label = agentOptions.find((option) => option.value === agent)!.label;
  let install: SetupStep;
  let authorize: SetupStep;
  let connectionCheck: string | null;
  switch (agent) {
    case "codex":
      install = {
        title: "Add Tidy to Codex",
        description: "Paste this command into your terminal.",
        values: [command(`codex mcp add ${name} --url ${resourceUrl}`)],
      };
      authorize = {
        title: "Authorize access",
        description:
          "Run this command. In the browser, approve access to Tidy, then return to Codex.",
        values: [command(`codex mcp login ${name}`)],
      };
      connectionCheck = "codex mcp list";
      break;
    case "claude":
      install = {
        title: "Add Tidy to Claude Code",
        description: "Paste this command into your terminal.",
        values: [command(`claude mcp add --transport http --scope user ${name} ${resourceUrl}`)],
      };
      authorize = {
        title: "Authorize access",
        description: `Enter this in Claude Code, select ${name}, and sign in to Tidy in the browser.`,
        values: [command("/mcp")],
      };
      connectionCheck = "claude mcp list";
      break;
    case "opencode":
      install = {
        title: "Add Tidy to OpenCode",
        description: `Run this command in your terminal. Choose Remote, name the server ${name}, and paste the URL below when asked.`,
        values: [command("opencode mcp add"), url(resourceUrl)],
      };
      authorize = {
        title: "Authorize access",
        description:
          "Run this command. In the browser, approve access to Tidy, then return to OpenCode.",
        values: [command(`opencode mcp auth ${name}`)],
      };
      connectionCheck = "opencode mcp list";
      break;
    case "pi":
      install = {
        title: "Add Tidy to Pi",
        description: "Paste this command into your terminal.",
        values: [command(`pi mcp add ${name} --url ${resourceUrl}`)],
      };
      authorize = {
        title: "Authorize access",
        description: "Run this command. In the browser, approve access to Tidy, then return to Pi.",
        values: [command(`pi mcp login ${name}`)],
      };
      connectionCheck = "pi mcp list";
      break;
    case "gemini":
      install = {
        title: "Add Tidy to Gemini CLI",
        description: "Paste this command into your terminal.",
        values: [command(`gemini mcp add --transport http --scope user ${name} ${resourceUrl}`)],
      };
      authorize = {
        title: "Authorize access",
        description:
          "Enter this in Gemini CLI. In the browser, approve access to Tidy, then return to Gemini CLI.",
        values: [command(`/mcp auth ${name}`)],
      };
      connectionCheck = "gemini mcp list";
      break;
    case "other":
      install = {
        title: "Add Tidy to your agent",
        description:
          "Add this URL as a remote Streamable HTTP MCP server in your agent’s settings.",
        values: [url(resourceUrl)],
      };
      authorize = {
        title: "Authorize access",
        description:
          "Enable browser-based OAuth in your agent. When it asks you to sign in, approve access to Tidy in the browser, then return to your agent.",
        values: [],
      };
      connectionCheck = null;
  }
  const steps: SetupStep[] = [
    install,
    authorize,
    {
      title: agent === "other" ? "Try it in your agent" : `Try it in ${label}`,
      description: `Send this prompt in ${agent === "other" ? "your agent" : label} to check that it can read your files.`,
      values: [{ value: "Use Tidy to list my design files.", copyLabel: "Copy prompt" }],
    },
  ];
  return { steps, connectionCheck };
}
