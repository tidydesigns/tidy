import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatLink } from "./chat-link";
import { PullRequestGlyph } from "./pull-request-icon";
import type { ReactNode } from "react";

const api = { openChatLink: async () => {} };
const render = (href: string | undefined, label: ReactNode = "Reference") =>
  renderToStaticMarkup(
    createElement(ChatLink, { href, api, projectId: "preview", children: label }),
  );

test("web, service, email and PR destinations select the appropriate icon", () => {
  for (const [href, icon] of [
    ["https://example.com/api_reference", "web"],
    ["http://localhost:3000", "web"],
    ["https://github.com/owner/repo", "github"],
    ["https://github.com/owner/repo/issues/42", "github"],
    ["https://gist.github.com/owner/hash", "github"],
    ["https://github.com.example.com/owner/repo/pull/42", "web"],
    ["https://github.com:444/owner/repo", "web"],
    ["mailto:design@example.com", "mail"],
  ] as const)
    expect(render(href)).toContain(`data-icon="${icon}"`);
  const pr = render("https://github.com/owner/repo/pull/42/files#diff-123");
  expect(pr).toContain("chat-pull-request-icon");
  expect(pr).not.toContain('data-icon="github"');
});

test("file references preserve custom rich labels and show complete line and column positions", () => {
  const output = render("src/Button.tsx:24:5", "Button.tsx:24:5");
  expect(output).toContain('data-icon="react"');
  expect(output).toContain('title="Show in folder: src/Button.tsx:24:5"');
  expect(output).toContain("· L24:C5");
  expect(output).not.toContain("<span>Button.tsx:24:5</span>");
  expect(render("src/Button.tsx:24:5", "Button.tsx:24")).not.toContain(
    "<span>Button.tsx:24</span>",
  );
  const rich = render("src/Button.tsx:24", createElement("strong", null, "Review this component"));
  expect(rich).toContain("<strong>Review this component</strong>");
});

test("media and unknown files use file chips", () => {
  for (const [href, icon] of [
    ["recordings/Review%20clip.MP4", "video"],
    ["recordings/feedback.wav", "audio"],
    ["assets/capture.png", "image"],
    ["docs/unknown.custom", "file"],
  ] as const) {
    const output = render(href);
    expect(output).toContain('class="chat-file-link"');
    expect(output).toContain(`data-icon="${icon}"`);
  }
});

test("unsupported links cannot render a clickable destination", () => {
  for (const href of [
    undefined,
    "javascript:alert(1)",
    "data:text/html,hello",
    "file://remote/share/a.mp4",
  ]) {
    expect(render(href, "Unavailable reference")).toBe("<span>Unavailable reference</span>");
  }
});

test("PR loading and unavailable states have distinct accessible labels", () => {
  const pending = renderToStaticMarkup(
    createElement(PullRequestGlyph, { state: null, checking: true }),
  );
  const unavailable = renderToStaticMarkup(createElement(PullRequestGlyph, { state: null }));
  expect(pending).toContain('aria-label="Checking pull request status"');
  expect(pending).not.toContain("status unavailable");
  expect(unavailable).toContain('aria-label="Pull request · status unavailable"');
  const refreshing = renderToStaticMarkup(
    createElement(PullRequestGlyph, { state: "merged", checking: true }),
  );
  expect(refreshing).toContain('aria-label="Merged pull request"');
});
