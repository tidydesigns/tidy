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
        description: "Run in your terminal.",
        values: [command(`codex mcp add ${name} --url ${resourceUrl}`)],
      };
      authorize = {
        title: "Sign in to Tidy",
        description: "Run in your terminal, then approve access in your browser.",
        values: [command(`codex mcp login ${name}`)],
      };
      connectionCheck = "codex mcp list";
      break;
    case "claude":
      install = {
        title: "Add Tidy to Claude Code",
        description: "Run in your terminal.",
        values: [command(`claude mcp add --transport http --scope user ${name} ${resourceUrl}`)],
      };
      authorize = {
        title: "Sign in to Tidy",
        description: `Run in Claude Code, select ${name}, then sign in.`,
        values: [command("/mcp")],
      };
      connectionCheck = "claude mcp list";
      break;
    case "opencode":
      install = {
        title: "Add Tidy to OpenCode",
        description: "Run in your terminal.",
        values: [command(`opencode mcp add ${name} --url ${resourceUrl}`)],
      };
      authorize = {
        title: "Sign in to Tidy",
        description: "Run in your terminal, then approve access in your browser.",
        values: [command(`opencode mcp auth ${name}`)],
      };
      connectionCheck = "opencode mcp list";
      break;
    case "pi":
      install = {
        title: "Add Tidy to Pi",
        description: "Run in your terminal.",
        values: [command(`pi mcp add ${name} --url ${resourceUrl}`)],
      };
      authorize = {
        title: "Sign in to Tidy",
        description: "Run in your terminal, then approve access in your browser.",
        values: [command(`pi mcp login ${name}`)],
      };
      connectionCheck = "pi mcp list";
      break;
    case "gemini":
      install = {
        title: "Add Tidy to Gemini CLI",
        description: "Run in your terminal.",
        values: [command(`gemini mcp add --transport http --scope user ${name} ${resourceUrl}`)],
      };
      authorize = {
        title: "Sign in to Tidy",
        description: "Run in Gemini CLI, then approve access in your browser.",
        values: [command(`/mcp auth ${name}`)],
      };
      connectionCheck = "gemini mcp list";
      break;
    case "other":
      install = {
        title: "Add Tidy to your agent",
        description: "In your agent’s settings, add this URL using Streamable HTTP.",
        values: [url(resourceUrl)],
      };
      authorize = {
        title: "Sign in to Tidy",
        description: "Enable OAuth in your agent, then sign in to Tidy when prompted.",
        values: [],
      };
      connectionCheck = null;
  }
  const steps: SetupStep[] = [
    install,
    authorize,
    {
      title: "Test the connection",
      description: `Send this prompt in ${agent === "other" ? "your agent" : label}.`,
      values: [{ value: "List my Tidy design files.", copyLabel: "Copy prompt" }],
    },
  ];
  return { steps, connectionCheck };
}
