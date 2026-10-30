import { expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { McpSetupGuide } from "@/components/mcp/setup-prompt";

mock.module("server-only", () => ({}));
const navigation = { ...(await import("next/navigation")) };
mock.module("next/navigation", () => ({
  ...navigation,
  useRouter: () => ({ refresh() {}, replace() {}, prefetch() {} }),
}));
const { McpOnboarding } = await import("./mcp-onboarding");
const setup = { resourceUrl: "https://example.test/api/mcp", organizationId: "selected-org" };

test("onboarding offers setup and skip until an authorization is confirmed", () => {
  const html = renderToStaticMarkup(<McpOnboarding {...setup} initialClients={[]} />);
  expect(html).toContain("Copy setup prompt");
  expect(html).toContain("Set up later");
  expect(html).not.toContain("You’re all set.");
  expect(html).not.toContain("Open Tidy");
});

test("already authorized users can finish onboarding without skipping setup", () => {
  const html = renderToStaticMarkup(
    <McpOnboarding {...setup} initialClients={[{ clientId: "codex", name: "Codex" }]} />,
  );
  expect(html).toContain("You’re all set.");
  expect(html).toContain("Codex is connected to Tidy.");
  expect(html).toContain("Open Tidy");
  expect(html).not.toContain("Copy setup prompt");
  expect(html).not.toContain("Set up later");
  expect(html).not.toContain('aria-current="step"');
});

test("copying keeps approval instructions visible while waiting for real authorization", () => {
  const render = (variant: "onboarding" | "workspace") =>
    renderToStaticMarkup(<McpSetupGuide {...setup} variant={variant} copied onCopied={() => {}} />);
  const onboarding = render("onboarding");
  expect(onboarding).toContain("Prompt copied");
  expect(onboarding).toContain("Paste the prompt");
  expect(onboarding).toContain("Copy setup prompt again");
  expect(onboarding).toContain("Waiting for your agent to connect…");
  expect(onboarding).not.toContain("You’re all set.");
  expect(render("workspace")).not.toContain("Waiting for your agent");
});
